"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { aggregateNodeId, clusterIdOfAggregate, isAggregateId } from "@/lib/graph/collapse";
import {
  buildAdjacency,
  connectionHighlight,
  type ConnectionRole,
  connectionRoles,
  connectionStatus,
  nextAnchors,
  pairKey,
  pruneAnchors,
} from "@/lib/graph/connections";
import {
  IncrementalSceneSession,
  type Scene,
  type SceneEdge,
  type SceneFilters,
} from "@/lib/graph/scene";
import type { GraphModel } from "@/lib/graph/types";
import type { PackageManifest } from "@/lib/graph/levels/types";
import type { DimensionCatalog, FacetKey } from "@/lib/graph/dimensions";
import type { FacetSelection } from "@/lib/graph/facet-selection";
import {
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
  layoutFallbackSummary,
} from "@/lib/layout";
import { frameBoxes } from "@/lib/graph/frame";
import { buildDirTree, type DirNode } from "@/lib/graph/hierarchy";
import type { CollapseIntent, GroupId } from "@/lib/graph/collapse-model";
import type { CompactGroupingSnapshot } from "@/lib/graph/grouping-snapshot";
import { buildGroupingSnapshot } from "@/lib/graph/grouping-snapshot";
import { directoryGrouping, syntheticNoneGrouping } from "@/lib/graph/grouping";
import { directoryLodSelection } from "@/lib/graph/lod-selection";
import { computeCut, computeCutTraced, cutEquals } from "@/lib/graph/lod-cut";
import { computeGroupCut, groupCutEquals, groupLodSelection } from "@/lib/graph/group-cut";
import {
  type RepLodResult,
  type RepresentationRuntime,
  acquireRepresentationRuntime,
  activeProxyBoxKeyOfNode,
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  materialSignature,
} from "@/lib/graph/lod-representation-cut";
import { cameraBand, proxyBoxes, sceneBoxes, shouldFit } from "@/lib/graph/lod-scene";
import { decideRecut, type RecutTrigger } from "@/lib/graph/lod-recut-mode";
import {
  centerCameraOn,
  contentBounds,
  fitProjection,
  viewportWorldRect,
} from "@/lib/graph/minimap";
import { telemetry } from "@/lib/telemetry";
import { LayoutOverlay } from "./LayoutOverlay";
import { useScene } from "./useScene";

// Adaptive-LOD tuning. Conservative starting values — a directory opens into its
// children once its on-screen height passes OPEN_PX, and the cut is capped at
// MAX_CARDS cards. These want desktop calibration (see docs/SCALE-100K.md).
const LOD_OPEN_PX = 240;
const LOD_MAX_CARDS = 800;
// Cap on estimated layout NODES (files + their symbols when expanded). Keep the cut's
// input under this so Smart finishes within the 8s worker timeout (never degrading to the
// grid fallback). Lowered from 2500 after desktop testing showed Smart timing out (>8s) on
// ~1.5k-node inputs from filter/zoom churn — not the optimistic ~1s-at-2.5k estimate.
// See docs/superpowers/plans/2026-06-18-nanite-lod-node-budget.md.
const LOD_NODE_BUDGET = 1500;
// Bound on RETAINED auto-opened group proxies (the deadband set): a group opened while
// on-screen stays open through a small pan/zoom-out, but exploring many regions can't grow
// the open set without limit — the IntrusiveLru evicts the oldest offscreen opens past this
// (spec "auto open & offscreen → eviction-eligible … over budget → evict … (LRU)").
const LOD_OFFSCREEN_OPEN_BUDGET = 64;
// Debounce the adaptive recompute so a single zoom *gesture* (many wheel ticks
// across bands) triggers ONE cut+rebuild after it settles — not one per tick. The
// rebuild reprocesses the whole base graph (1.39M nodes on the kernel), so coalescing
// is the difference between a usable zoom and a multi-second-per-frame freeze.
const LOD_RECUT_DEBOUNCE_MS = 200;

export interface GraphViewProps {
  graph: GraphModel;
  expanded: Set<string>;
  /** Symbols per file id — the cut adds these to its node budget for expanded files. */
  symbolCount: Map<string, number>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  search: string;
  selectedId: string | null;
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  groupBy: GroupBy;
  density: number;
  showExternal: boolean;
  /** Sparse facet selections (kind/category/env/runtime/role + provider facets). */
  enabledFacets: Map<FacetKey, FacetSelection>;
  /** The catalog the scene gate resolves facet values against. */
  catalog: DimensionCatalog;
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
  collapsedClusters: Set<string>;
  communityCollapse: boolean;
  edgeRouting: "curved" | "orthogonal";
  focusedIds: Set<string> | null;
  /** Query "filter" mode: restrict the visible graph to these ids (∩ filters). */
  queryIds: Set<string> | null;
  /** Query "highlight" mode: keep the full graph but emphasise these ids and frame them. */
  highlightIds: Set<string> | null;
  /** True at the Package/Workspace levels, where the graph is a projection. */
  projected: boolean;
  /** Package manifests, for the "package" grouping mode's layout snapshot. */
  manifests?: PackageManifest[];
  onSelect: (id: string) => void;
  onToggleExpand: (fileId: string) => void;
  onToggleCollapse: (clusterId: string) => void;
  onSelectEdge: (edge: SceneEdge) => void;
  /** Show the navigation minimap overlay (graph extent + viewport rect). */
  minimap?: boolean;
  /** Adaptive level-of-detail: recompute the collapsed cut as the camera zooms. */
  adaptiveLod?: boolean;
  /**
   * Called when the adaptive cut changes with the GroupLodSelection — the set of OPEN
   * namespaced group ids — FOR the active grouping mode (the modeKey is the first arg, so
   * the camera state stays per-mode). It updates only the selection layer of the
   * three-layer collapse model (spec "Three-layer collapse"); the camera owns this layer
   * alone and never writes user intent or the bootstrap.
   */
  onCut?: (modeKey: string, selection: Set<GroupId>) => void;
  /**
   * Reports the community assignment the scene actually laid out (detected over the
   * FILTERED graph). Explorer feeds it back into the cut snapshot so its "Community N"
   * box keys match the rendered boxes — otherwise re-detecting over the full graph
   * relabels communities under filters and silently disables Community-mode LOD. Null in
   * non-community modes / before the first scene.
   */
  onCommunityOf?: (communityOf: Map<string, string> | null) => void;
  /**
   * The active grouping mode's CUT snapshot (full, over the rendered graph). Directory
   * keeps its dedicated DirNode cut (null here); every OTHER mode supplies a snapshot so
   * the camera runs the mode-agnostic computeGroupCut. Null disables the generic cut.
   */
  groupingSnapshot?: CompactGroupingSnapshot | null;
  /**
   * Phase C1b: when true (AND adaptiveLod is on AND a groupingSnapshot exists), the camera
   * runs the REPRESENTATION cut — a budgeted valid antichain through the proxy hierarchy
   * (Appendix A) — instead of the C1a collapse-shaped computeGroupCut. The result still
   * flows through `onCut` as a GroupLodSelection, so the render path is unchanged. Gated
   * (default off) so the C1a path stays the byte-identical fallback.
   */
  representationLod?: boolean;
  /**
   * The active grouping mode's user collapse INTENT (group id → open/closed). The
   * representation cut consumes it as solver constraints (forceClosed/forceOpen). Unused by
   * the C1a path (which receives the already-composed collapsedClusters).
   */
  intent?: CollapseIntent;
  /** Dev: observe each committed representation cut (overlay / telemetry). */
  onRepLod?: (result: RepLodResult) => void;
  /**
   * P1 incremental proxy materialization (design impl point 4 / Gap 9). When supplied AND the
   * representation cut is active, each COMMITTED cut is folded by a persistent
   * {@link IncrementalSceneSession}: the first cut runs the full O(N) fold, every later cut diffs
   * against the prior committed cut and re-folds ONLY the changed subtrees + their incident
   * boundary edges (cost proportional to the changed region, never O(all nodes + all edges)). The
   * folded GraphModel is handed up here so the owner can adopt it as the render scene. Optional —
   * omitted → the canvas only produces the cut (the existing `onCut` selection path is unchanged).
   */
  onProxyScene?: (scene: GraphModel) => void;
  /**
   * Signature of everything that warrants re-framing the camera (graph, level,
   * filters) but NOT the cut. When it's unchanged across a scene update, the
   * camera is preserved instead of re-fitting — so an adaptive recut doesn't
   * yank the view. When undefined the camera re-fits on every ready scene change;
   * Explorer provides a signature whenever a graph is loaded.
   */
  fitSignature?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Linear blend between two RGB colors (t in [0,1]). Used to fade the de-emphasis in. */
function lerpRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Stable categorical color for a container box, keyed by its group id (directory /
// package / community), so each functional area gets its own consistent hue. Mid
// saturation/lightness keeps it readable on both light and dark canvases.
function clusterColor(id: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return hslToRgb((h >>> 0) % 360, 0.5, 0.62);
}

// Muted gray for nodes/edges outside the highlight set (readable in both themes).
const DIM_RGB: [number, number, number] = [90, 99, 112];
// Connection-highlight ring color per path role, drawn as an OUTLINE only (the card keeps its own
// kind-color so its type still reads). Blue start matches the selection outline.
const ROLE_RGB: Record<ConnectionRole, [number, number, number]> = {
  start: [59, 130, 246], // blue
  end: [239, 68, 68], // red
  path: [234, 179, 8], // yellow
};

// The per-node shape the renderer deserializes (vello-renderer NodeData). Named so the object
// literal below stays in sync with the Rust struct — a renamed/missing field or a wrong color
// tuple is then a compile error here, not a silent "bad scene json" at runtime. `outline` is
// optional: omitted (undefined) for non-highlighted nodes → serde reads it as None.
interface VelloNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: [number, number, number];
  outline?: [number, number, number];
  label: string;
  shape: string;
  badge: string;
  lang: string;
  lang_color: [number, number, number];
}

interface VelloHandle {
  set_data: (json: string) => void;
  stats: () => string;
  set_camera: (x: number, y: number, scale: number) => void;
  set_selection: (id: string | undefined) => void;
  set_search: (q: string) => void;
  set_phase: (p: number) => void;
  set_theme: (dark: boolean) => void;
  fit: () => Float64Array | number[];
  pick: (px: number, py: number) => string | undefined;
  resize: (w: number, h: number) => void;
  render: () => void;
  free?: () => void;
}

export function VelloGraphCanvas(props: GraphViewProps) {
  const {
    graph,
    expanded,
    symbolCount,
    enabledEdgeKinds,
    search,
    selectedId,
    algorithm,
    direction,
    groupBy,
    density,
    showExternal,
    enabledFacets,
    catalog,
    enabledFolders,
    enabledLanguages,
    collapsedClusters,
    communityCollapse,
    edgeRouting,
    focusedIds,
    queryIds,
    highlightIds,
    projected,
    manifests,
    onSelect,
    onToggleExpand,
    onToggleCollapse,
    onSelectEdge,
    minimap = true,
    adaptiveLod,
    onCut,
    onCommunityOf,
    groupingSnapshot,
    representationLod,
    intent,
    onRepLod,
    onProxyScene,
    fitSignature,
  } = props;

  const filters: SceneFilters = useMemo(
    () => ({
      showExternal,
      enabledFacets,
      enabledEdgeKinds,
      enabledFolders,
      enabledLanguages,
    }),
    [showExternal, enabledFacets, enabledEdgeKinds, enabledFolders, enabledLanguages],
  );

  // The AUTHORITATIVE rep-cut render scene (design impl point 5). When `representationLod` is on,
  // the recut materializes the committed cut into a folded proxy GraphModel and stores it here;
  // `useScene` then builds the rendered structure DIRECTLY from it (NOT from
  // `compose()`/`collapsedClusters`/`collapseClusters()`). Null until the first committed cut (the
  // C1a base structure renders meanwhile as the bootstrap) and whenever representationLod is off.
  const [repScene, setRepScene] = useState<{ scene: GraphModel; cutSignature: string } | null>(
    null,
  );

  const {
    scene,
    layingOut,
    ready: layoutReady,
    communityOf,
    visibleNodeIds,
  } = useScene(
    graph,
    expanded,
    filters,
    algorithm,
    direction,
    collapsedClusters,
    groupBy,
    density,
    communityCollapse,
    focusedIds,
    queryIds,
    projected,
    catalog,
    manifests,
    representationLod ? repScene : null,
  );
  const { resolvedTheme } = useTheme();

  // Report the scene's community assignment up so Explorer's cut snapshot reuses the SAME
  // (filtered-graph) labels the layout used — keeping Community-mode LOD box keys aligned
  // with the rendered boxes. Fires only when the map identity changes (it's memoized in
  // the scene structure). Explorer guards against redundant updates.
  useEffect(() => {
    onCommunityOf?.(communityOf ?? null);
  }, [communityOf, onCommunityOf]);

  // "Layout simplified" notice: surfaces when the budget guard downgraded any Smart cluster's
  // engine (e.g. Layered → Grid for an oversized component), so a grid fallback isn't mistaken
  // for the chosen engine producing a poor result. Null when nothing was downgraded.
  const fallbackNote = useMemo(() => layoutFallbackSummary(scene.clusters), [scene.clusters]);

  // Connection highlighting: a single click lights a card + its direct neighbors; shift-click a
  // second card lights the shortest (undirected) path between them. Anchors are scene ids, so it
  // works at any collapse/expand level. It takes precedence over the query highlight for dimming,
  // but never reframes the camera (framing stays tied to the query-highlight prop).
  const [anchors, setAnchors] = useState<string[]>([]);
  const onAnchor = useCallback((id: string, shift: boolean) => {
    setAnchors((prev) => nextAnchors(prev, id, shift));
  }, []);
  // No-op when already empty so an empty-space click or stray Esc doesn't force a re-render.
  const clearAnchors = useCallback(() => setAnchors((prev) => (prev.length ? [] : prev)), []);
  // Tracks the previous plain click so a quick second click on the same card = double-click.
  const lastClick = useRef<{ id: string; time: number }>({ id: "", time: 0 });
  const sceneIds = useMemo(() => new Set(scene.nodes.map((n) => n.id)), [scene.nodes]);
  // Phase C1b — a SELECTED HIDDEN node highlights its active proxy: when the selection is a
  // node currently folded into a proxy (not in the scene), resolve it to that proxy's
  // aggregate card id so the renderer's selection outline lands on the visible proxy. Recomputed
  // on a selection or scene change; falls back to the raw selectedId when it's visible or there
  // is no representation result. (No-op outside the representation cut — lastRep stays null.)
  const nodeOrdinalById = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < graph.nodes.length; i++) m.set(graph.nodes[i].id, i);
    return m;
  }, [graph.nodes]);
  const effectiveSelectionId = useMemo(() => {
    if (!selectedId || sceneIds.has(selectedId)) return selectedId ?? undefined;
    const rep = lastRep.current;
    const ord = nodeOrdinalById.get(selectedId);
    if (!rep || ord === undefined) return selectedId;
    const boxKey = activeProxyBoxKeyOfNode(rep, ord);
    if (boxKey == null) return selectedId;
    const aggId = aggregateNodeId(boxKey);
    return sceneIds.has(aggId) ? aggId : selectedId;
    // lastRep is a ref (read at compute time); scene changes drive the recompute via sceneIds.
  }, [selectedId, sceneIds, nodeOrdinalById]);
  // containment edges are dropped inside buildAdjacency, so paths run through code relationships.
  const connAdj = useMemo(() => buildAdjacency(scene.edges), [scene.edges]);
  // Actively prune anchors whose card left the scene on an LOD/collapse transition, so a stale
  // (now-invisible) endpoint can't linger in state behind a still-visible one.
  useEffect(() => {
    setAnchors((prev) => pruneAnchors(prev, sceneIds));
  }, [sceneIds]);
  const liveAnchors = useMemo(() => anchors.filter((a) => sceneIds.has(a)), [anchors, sceneIds]);
  const conn = useMemo(() => connectionHighlight(liveAnchors, connAdj), [liveAnchors, connAdj]);
  const effectiveHighlight = conn ? conn.nodeIds : highlightIds;
  const labelById = useMemo(() => new Map(scene.nodes.map((n) => [n.id, n.label])), [scene.nodes]);
  const connStatus = useMemo(
    () => connectionStatus(liveAnchors, conn, (id) => labelById.get(id) ?? id),
    [liveAnchors, conn, labelById],
  );
  // A stable key for the current selection: changes only when the anchors change (not on
  // scene-only churn). Drives both the connection log and the focus-fade ramp.
  const highlightKey = conn ? `c:${liveAnchors.join("")}` : highlightIds ? "q" : "";

  // Session-log connection selections (once per distinct selection — the ref dedups the extra
  // fires from scene-only changes). Covers the #72 feature in the downloadable log.
  const lastLoggedConn = useRef("");
  useEffect(() => {
    if (highlightKey.startsWith("c:") && conn && highlightKey !== lastLoggedConn.current) {
      lastLoggedConn.current = highlightKey;
      telemetry.event("interaction", "connection", {
        anchors: liveAnchors.length,
        connected: conn.connected,
        steps: conn.path ? conn.path.length - 1 : null,
        ids: liveAnchors,
      });
    }
  }, [highlightKey, conn, liveAnchors]);

  // Focus animation: when the selection changes, fade the de-emphasis IN (dimmed cards/edges
  // ramp from full colour → grey over ~180ms) so the highlight resolves smoothly instead of
  // snapping. dimT 0 = no dim, 1 = full dim. Skipped on large scenes, where re-encoding the
  // payload each frame would be costly (it just snaps to 1).
  const [dimT, setDimT] = useState(1);
  // animatable is a boolean (flips only at the size threshold), so it's safe in the deps — the
  // ramp re-runs on a selection change or when the scene crosses the threshold, not every frame.
  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    [],
  );
  // Bound the fade by total payload work (nodes + edges), not just node count — each frame
  // re-serializes the whole node+edge payload, so an edge-heavy graph (e.g. 700 nodes / 40k
  // edges) would jank. Honor reduced-motion too (the fade is decorative). Boolean → safe in deps.
  const animatable = scene.nodes.length + scene.edges.length <= 10_000 && !prefersReducedMotion;
  useEffect(() => {
    if (!highlightKey || !animatable) {
      setDimT(1);
      return;
    }
    setDimT(0);
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (start === 0) start = ts;
      const t = Math.min(1, (ts - start) / 180);
      setDimT(t);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [highlightKey, animatable]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vcRef = useRef<VelloHandle | null>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  // Synced to the prop each render so the mount-once effect's draw loop reads the
  // live value (the canvas stays mounted and is CSS-toggled).
  const minimapOn = useRef(minimap);
  minimapOn.current = minimap;
  // The effect owns the minimap draw fn; expose it so a scene change can redraw the
  // minimap (camera changes already redraw it via renderSoon).
  const drawMinimapRef = useRef<(() => void) | null>(null);
  const cam = useRef({ x: 0, y: 0, scale: 1 });
  // Smallest zoom the wheel allows; tracks fit() so a graph too big to fit above the
  // normal floor (e.g. the fully-expanded symbol level) can still be zoomed all the way out.
  const minScale = useRef(0.02);
  const dpr = useRef(1);
  const isFile = useRef(new Map<string, boolean>());
  const edgesById = useRef(new Map<string, SceneEdge>());
  edgesById.current = new Map(scene.edges.map((e) => [e.id, e]));
  const handlers = useRef({
    onSelect,
    onToggleExpand,
    onToggleCollapse,
    onSelectEdge,
    onAnchor,
    clearAnchors,
  });
  handlers.current = {
    onSelect,
    onToggleExpand,
    onToggleCollapse,
    onSelectEdge,
    onAnchor,
    clearAnchors,
  };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The most recent representation-cut result (Phase C1b), written by recomputeCut. Read on
  // the render side to map a SELECTED HIDDEN node to its active proxy's aggregate card so the
  // selection outline lands on the visible proxy (spec: "a selected hidden node highlights
  // its active proxy"). Holds the hierarchy + runtimeCut for the representativeOf walk.
  const lastRep = useRef<RepLodResult | null>(null);

  // A handle to the mount-effect's `recomputeCut`, so effects OUTSIDE the mount effect (e.g. the
  // scene-ready effect that fires the FIRST cut when a new scene lands) can trigger a recut without
  // a camera gesture. Assigned once the mount effect installs the listeners; null before that.
  const recomputeCutRef = useRef<((trigger: RecutTrigger) => void) | null>(null);

  // The PERSISTENT representation runtime (design Gap 4): the cached hierarchy, node
  // ordinals, group-id map, eviction + runtime-cut controller, and committed-generation
  // runtime. A camera recut REUSES this (updating bounds/priorities/cut) rather than
  // rebuilding the O(N) hierarchy; it is rebuilt only when the material signature changes
  // (filtered-graph identity + grouping mode/version + node-cost inputs + builder version).
  // Reset on a grouping-mode switch (the rep id domain moves). The eviction controller that
  // was a standalone ref now lives INSIDE this runtime.
  const repRuntimeRef = useRef<RepresentationRuntime | undefined>(undefined);
  // The PERSISTENT incremental materialization session (design impl point 4 / Gap 9). Paired with
  // `repRuntimeRef`: rebuilt whenever the runtime is (a fresh hierarchy / post-filter projection),
  // then driven each committed cut to re-fold ONLY the changed subtrees. Its `signature` mirrors
  // the runtime's so the canvas can detect a stale session and rebuild it in lockstep. Null until
  // the first committed representation cut, or whenever `onProxyScene` is absent (no consumer).
  const proxySessionRef = useRef<{ session: IncrementalSceneSession; signature: string } | null>(
    null,
  );
  // Reference-identity tokens for the material signature: a monotonic id per distinct object
  // reference (graph / snapshot / visible-set / cost inputs). React hands a NEW reference on
  // a real change, so comparing references is a cheap, correct proxy for "did the material
  // inputs change?" without an O(N) content hash each recut.
  const idTokens = useRef(new WeakMap<object, number>());
  const nextIdToken = useRef(1);
  const tokenOf = (o: object): number => {
    let t = idTokens.current.get(o);
    if (t === undefined) {
      t = nextIdToken.current++;
      idTokens.current.set(o, t);
    }
    return t;
  };

  // Adaptive level-of-detail state the (mount-time) wheel handler reads via refs.
  const dirTree = useMemo(() => buildDirTree(graph), [graph]);
  // Phase C1b: Directory and None modes have no `groupingSnapshot` prop (Directory uses the
  // DirNode cut; None renders no visible containers), so build one here for the representation
  // cut. Only when representationLod is on AND the mode is one of those — otherwise this is null
  // and never built (the snapshot prop covers the rest).
  //
  //   - Directory → directoryGrouping (the canvas's own DirNode path has no snapshot).
  //   - None → syntheticNoneGrouping (components → communities, design Gap 2 / P2). Explorer
  //     deliberately returns NO `cutGrouping` snapshot for None (it has no visible containers,
  //     so the C1a seed/intent/cluster machinery must not run for it). The representation cut,
  //     however, needs a hierarchy to bound None's budget — fed ONLY here so it drives the rep
  //     path (stable, layout-independent proxy bounds) WITHOUT drawing group boxes. None emits
  //     no live cluster boxes, so the cut runs purely on stable bounds and renders FLAT.
  const directoryRepSnapshot = useMemo(() => {
    if (!representationLod) return null;
    if (groupBy === "directory") {
      return buildGroupingSnapshot(
        directoryGrouping(graph),
        "directory",
        graph.nodes.map((n) => n.id),
      );
    }
    if (groupBy === "none") {
      return buildGroupingSnapshot(
        syntheticNoneGrouping(graph),
        "none",
        graph.nodes.map((n) => n.id),
      );
    }
    return null;
  }, [representationLod, groupBy, graph]);
  const lod = useRef<{
    adaptiveLod?: boolean;
    onCut?: (modeKey: string, selection: Set<GroupId>) => void;
    dirTree: DirNode;
    scene: Scene;
    // The RAW collapsed cut this canvas last handed up (computeCut's bare-path frontier) —
    // the cut-domain. Deliberately NOT the effective `collapsedClusters` prop, which is the
    // COMPOSED set and carries redundant deeper entries under any collapsed non-leaf dir.
    // Every cut-domain comparison (hysteresis prevCut, the no-op skip-guard, telemetry
    // deltas) must use this, or it diverges from the pre-C0 raw-cut-vs-raw-cut semantics.
    // Owned by the canvas: persists across renders, written only when a cut is produced.
    rawCut: Set<string>;
    expanded: Set<string>;
    symbolCount: Map<string, number>;
    groupBy: GroupBy;
    // The active mode's CUT snapshot (non-directory modes), for the mode-agnostic cut.
    groupingSnapshot: CompactGroupingSnapshot | null;
    // Phase C1b representation-cut inputs + the committed runtime (persists across recuts).
    representationLod?: boolean;
    intent?: CollapseIntent;
    onRepLod?: (result: RepLodResult) => void;
    onProxyScene?: (scene: GraphModel) => void;
    graph: GraphModel;
    directoryRepSnapshot: CompactGroupingSnapshot | null;
    // POST-FILTER visible base-node ids (Gap 7): the rep cut builds its hierarchy from this
    // projection so filtered-out nodes add no proxy-subtree cost / card pressure.
    visibleNodeIds: Set<string>;
  }>({
    adaptiveLod,
    onCut,
    dirTree,
    scene,
    rawCut: new Set(),
    expanded,
    symbolCount,
    groupBy,
    groupingSnapshot: groupingSnapshot ?? null,
    representationLod,
    intent,
    onRepLod,
    onProxyScene,
    graph,
    directoryRepSnapshot,
    visibleNodeIds,
  });
  lod.current.adaptiveLod = adaptiveLod;
  lod.current.onCut = onCut;
  lod.current.dirTree = dirTree;
  lod.current.scene = scene;
  lod.current.expanded = expanded;
  lod.current.symbolCount = symbolCount;
  lod.current.representationLod = representationLod;
  lod.current.intent = intent;
  lod.current.onRepLod = onRepLod;
  lod.current.onProxyScene = onProxyScene;
  lod.current.graph = graph;
  lod.current.directoryRepSnapshot = directoryRepSnapshot;
  lod.current.visibleNodeIds = visibleNodeIds;
  // On a grouping-mode switch, drop the raw cut: it holds the PREVIOUS mode's box keys
  // (e.g. directory paths while now in Community), which live in a disjoint key domain.
  // Carrying it over makes the first post-switch cut read every group as "was open" and
  // apply the relaxed hysteresis threshold to all of them. Reset so hysteresis compares
  // within the active mode's key domain (the fit effect resets lodBand but not rawCut).
  // Also drop the persistent representation runtime so the new mode rebuilds its hierarchy
  // and starts a fresh generation chain. (The runtime's material signature includes the
  // mode key, so it would rebuild anyway; clearing the ref also frees the old eviction
  // controller, whose tracked rep ids belong to the OLD mode's disjoint id domain.)
  if (lod.current.groupBy !== groupBy) {
    lod.current.rawCut = new Set();
    repRuntimeRef.current = undefined;
    proxySessionRef.current = null; // the rep id domain moved — start a fresh fold session
  }
  lod.current.groupBy = groupBy;
  lod.current.groupingSnapshot = groupingSnapshot ?? null;
  const lodBand = useRef(cameraBand(1));

  // Drop the authoritative rep scene when the rep id domain moves (a grouping-mode switch), the
  // rep cut is turned off, OR the POST-FILTER projection could have changed (graph / filters /
  // query narrowing). A folded scene from the OLD mode (or a now-disabled cut) must not keep
  // rendering; just as important, a fold from the PRIOR filter set is stale —
  // `buildSceneStructureFromModel` renders the materialized nodes VERBATIM (it deliberately does
  // not re-filter), so a now-hidden node would linger as a rendered own-node and a proxy's
  // member-count badge would be wrong until the next committed recut lands. Clearing here drops to
  // the always-correct C1a base structure for one frame (the honest bootstrap) instead of showing
  // the stale fold. The scene-ready effect then fires a recut that repopulates `repScene` from the
  // new projection. (This effect only invalidates; the recut owns repopulation.)
  useEffect(() => {
    setRepScene(null);
  }, [groupBy, representationLod, graph, filters, queryIds]);

  // The JSON payload Vello consumes. Built from the positioned scene.
  const payload = useMemo(() => {
    // Mute everything outside the highlight set so the matches pop. Nodes dim by membership.
    const dimNode = (id: string) => effectiveHighlight != null && !effectiveHighlight.has(id);
    // Connection roles → an outline ring (not a fill): start (blue), destination (red), and the
    // nodes between them on the path (yellow). Outline-only keeps each card's kind-color intact,
    // so the ring reads as "role" rather than "different type". Empty map when nothing's anchored.
    const roles = connectionRoles(liveAnchors, conn);
    const outlineFor = (id: string): [number, number, number] | undefined => {
      const role = roles.get(id);
      return role ? ROLE_RGB[role] : undefined;
    };
    // Edges dim by EXACT pair in connection mode (so a chord between two lit nodes stays dim),
    // and by "both endpoints lit" in query-highlight mode (which has no edge set).
    const dimEdge = (source: string, target: string) =>
      conn
        ? !conn.edgePairs.has(pairKey(source, target))
        : highlightIds != null && (!highlightIds.has(source) || !highlightIds.has(target));
    const center = new Map<string, [number, number]>();
    const map = new Map<string, boolean>();
    for (const n of scene.nodes) {
      center.set(n.id, [n.x + n.width / 2, n.y + n.height / 2]);
      map.set(n.id, n.isFile);
    }
    isFile.current = map;
    const nodes: VelloNode[] = scene.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.width,
      h: n.height,
      color: dimNode(n.id) ? lerpRgb(hexToRgb(n.color), DIM_RGB, dimT) : hexToRgb(n.color),
      outline: outlineFor(n.id),
      label: n.label,
      shape: n.shape,
      badge: n.isFile && n.symbolCount > 0 ? `+${n.symbolCount}` : "",
      lang: n.lang?.code ?? "",
      lang_color: n.lang ? hexToRgb(n.lang.color) : [0, 0, 0],
    }));
    const edges = scene.edges
      .filter((e) => e.kind !== "contains")
      .map((e) => {
        const a = center.get(e.source);
        const b = center.get(e.target);
        if (!a || !b) return null;
        const muted = dimEdge(e.source, e.target);
        return {
          id: e.id,
          x1: a[0],
          y1: a[1],
          x2: b[0],
          y2: b[1],
          color: muted ? lerpRgb(hexToRgb(e.color), DIM_RGB, dimT) : hexToRgb(e.color),
          count: e.count,
        };
      })
      .filter(Boolean);
    const clusters = scene.clusters.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      w: c.width,
      h: c.height,
      depth: c.depth,
      label: c.label,
      color: clusterColor(c.id),
    }));
    return JSON.stringify({ nodes, edges, clusters, routing: edgeRouting });
  }, [scene, edgeRouting, effectiveHighlight, conn, liveAnchors, highlightIds, dimT]);

  // One-time Vello/WebGPU setup + camera interaction.
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    let destroyed = false;
    let raf = 0;

    // Minimap: graph extent (downsampled dots) + the current viewport rectangle,
    // drawn on a small 2D-canvas overlay. CSS pixels; scaled by dpr.
    const MM_W = 200;
    const MM_H = 140;
    const MM_PAD = 6;
    const drawMinimap = () => {
      const mc = minimapRef.current;
      if (!mc || !minimapOn.current) return;
      const ratio = dpr.current;
      const w = Math.round(MM_W * ratio);
      const h = Math.round(MM_H * ratio);
      if (mc.width !== w || mc.height !== h) {
        mc.width = w;
        mc.height = h;
      }
      const ctx = mc.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const sc = lod.current.scene;
      const bounds = contentBounds(sc);
      if (!bounds) return;
      const proj = fitProjection(bounds, w, h, MM_PAD * ratio);
      // Downsampled node dots (cap the work regardless of scene size).
      const nodes = sc.nodes;
      const step = Math.max(1, Math.floor(nodes.length / 2500));
      const d = Math.max(1, ratio);
      ctx.fillStyle = "rgba(120,134,156,0.6)";
      for (let i = 0; i < nodes.length; i += step) {
        const n = nodes[i]!;
        const p = proj.toMap(n.x + n.width / 2, n.y + n.height / 2);
        ctx.fillRect(p.x, p.y, d, d);
      }
      // Current viewport rectangle (clamped to the map for legibility).
      const main = canvasRef.current;
      const vp = viewportWorldRect(cam.current, main?.width ?? 1, main?.height ?? 1);
      const tl = proj.toMap(vp.minX, vp.minY);
      const br = proj.toMap(vp.maxX, vp.maxY);
      const rx = Math.max(0, tl.x);
      const ry = Math.max(0, tl.y);
      const rw = Math.min(w, br.x) - rx;
      const rh = Math.min(h, br.y) - ry;
      ctx.strokeStyle = "rgba(59,130,246,0.95)";
      ctx.lineWidth = Math.max(1, ratio);
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
    };
    drawMinimapRef.current = drawMinimap;

    // Recenter the camera on the world point under a minimap click/drag.
    const recenterFromMinimap = (clientX: number, clientY: number) => {
      const mc = minimapRef.current;
      const bounds = contentBounds(lod.current.scene);
      if (!mc || !bounds) return;
      const rect = mc.getBoundingClientRect();
      const mx = (clientX - rect.left) * dpr.current;
      const my = (clientY - rect.top) * dpr.current;
      const proj = fitProjection(bounds, mc.width, mc.height, MM_PAD * dpr.current);
      const world = proj.toWorld(mx, my);
      const main = canvasRef.current;
      const ncam = centerCameraOn(
        world.x,
        world.y,
        cam.current.scale,
        main?.width ?? 1,
        main?.height ?? 1,
      );
      cam.current = ncam;
      vcRef.current?.set_camera(ncam.x, ncam.y, ncam.scale);
      renderSoon();
    };

    const renderSoon = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        vcRef.current?.render();
        drawMinimap();
      });
    };

    // Marching-ants animation: advance the dash phase + redraw each frame, but
    // only while zoomed in enough to perceive it (keeps the zoomed-out case — where
    // the whole graph is on screen — cheap, since dashes are sub-pixel there anyway).
    const ANIM_MIN_SCALE = 0.35;
    let animRaf = 0;
    let phase = 0;
    let lastFrame = 0;
    let fpsFrames = 0;
    let fpsSince = 0;
    const animate = () => {
      animRaf = requestAnimationFrame(animate);
      const vc = vcRef.current;
      if (!vc || cam.current.scale < ANIM_MIN_SCALE) {
        // Paused (zoomed out, or no canvas): drop the frame clock so the next resumed
        // frame doesn't bill the whole pause gap as one giant frameMs / skewed FPS.
        lastFrame = 0;
        fpsSince = 0;
        fpsFrames = 0;
        return;
      }
      phase = (phase + 0.6) % 12;
      vc.set_phase(-phase);
      vc.render();
      // Frame timing → rolling metric; a throttled fps summary → event (~1/s) so the
      // log isn't flooded with per-frame entries.
      if (telemetry.isEnabled()) {
        const now = performance.now();
        if (lastFrame) telemetry.metric("render.frameMs", now - lastFrame);
        lastFrame = now;
        fpsFrames += 1;
        if (fpsSince === 0) fpsSince = now;
        else if (now - fpsSince >= 1000) {
          const fps = (fpsFrames * 1000) / (now - fpsSince);
          telemetry.metric("render.fps", fps);
          telemetry.event("render", "fps", { fps: Math.round(fps), frames: fpsFrames }, "debug");
          fpsFrames = 0;
          fpsSince = now;
        }
      }
    };

    const sizeCanvas = () => {
      const ratio = window.devicePixelRatio || 1;
      dpr.current = ratio;
      canvas.width = Math.max(1, Math.floor(el.clientWidth * ratio));
      canvas.height = Math.max(1, Math.floor(el.clientHeight * ratio));
    };

    let dragging = false;
    let last = { x: 0, y: 0 };
    let moved = 0;
    let recutTimer: ReturnType<typeof setTimeout> | undefined;

    // Recompute the adaptive cut from what's currently on screen and hand the new
    // collapsed set up. The box coordinates come from the live scene, so the cut
    // decision matches exactly what the user sees. No-op unless adaptiveLod is on.
    //
    // `trigger` separates the two camera gestures (design Gap 8 — "Eviction LRU ignores
    // panning"; "zoom → band/deadband refine; pan → visibility/LRU only"):
    //   • "wheel" — a ZOOM gesture: may REFINE to a higher band (advances lodBand). Monotonic
    //     (never re-collapses on zoom-out); the C1a fallback paths below also gate on this.
    //   • "pan"  — a DRAG gesture: refreshes on-screen VISIBILITY + the eviction LRU at the
    //     SAME band WITHOUT advancing lodBand (no forced deeper refinement). Before this, the
    //     recut fired only from the wheel handler and the band guard rejected any non-zoom
    //     recompute, so panning an open region off-screen never updated retention / eviction.
    const recomputeCut = (trigger: RecutTrigger) => {
      const l = lod.current;
      if (!l.adaptiveLod || !l.onCut) return;
      // The cut measures each group's on-screen size from the live scene's boxes (open
      // ClusterBoxes + collapsed aggregate cards). When there are NO boxes at all — the
      // grid fallback (forced on large/dense graphs) and groupBy:"none" emit none — every
      // group reads as "off-screen, height 0" and the cut would wrongly collapse the whole
      // graph (the disappearing view). With no hierarchy boxes to measure, leave the cut
      // alone. (Generalized from the old groupBy!=="directory" + zero-cluster guards: the
      // cut now runs in EVERY mode via boxKey, fixing the bug where changing the group mode
      // disabled LOD.)
      // Box geometry the cut measures from. Once the rep cut is authoritative, the rendered scene
      // is the materializer's proxy cards — a collapsed group is a generic `«proxy»` card, NOT an
      // `isAggregateId` directory card — so read collapsed-group bounds via `proxyBoxes` (rep →
      // group → box key through the prior cut's hierarchy). Open groups still come from
      // scene.clusters in both. Before the first committed cut (no hierarchy yet) the C1a base
      // structure is what's rendered, so the directory-aggregate `sceneBoxes` is correct.
      const prevHier = lastRep.current?.hierarchy;
      const boxes =
        l.representationLod && prevHier ? proxyBoxes(l.scene, prevHier) : sceneBoxes(l.scene);
      // The C1a fallback cuts measure ONLY from live boxes, so with none they would wrongly collapse
      // the whole view — keep the early-return for them. The representation path no longer depends
      // on live boxes: it carries STABLE, layout-independent proxy bounds (design Gap 3 / P2), so it
      // OPERATES under box-less engines (Grid / classic / None) where `boxes.size === 0`. So only
      // bail here when the representation path will NOT run (representationLod off or no snapshot).
      const repSnap = l.groupingSnapshot ?? l.directoryRepSnapshot;
      const willRunRepCut = l.representationLod && !!repSnap;
      if (boxes.size === 0 && !willRunRepCut) return;
      const c = cam.current;
      const band = cameraBand(c.scale);
      // Apply the camera policy. Zoom only ever REFINEs as the user zooms IN (band increases),
      // advancing lodBand — never re-collapsing on zoom-out (collapsing the view you're looking
      // at is the disliked behavior; once opened a region stays open). Pan runs in VISIBILITY
      // mode at the unchanged band so the rep cut updates retention + the eviction LRU from the
      // new viewport, without forcing deeper refinement. lodBand resets on a new scan / expand /
      // collapse-all; the solver still caps the open set at maxCards.
      const decision = decideRecut(trigger, band, lodBand.current);
      if (decision.skip) return;
      const prevBand = lodBand.current;
      // Only a refine advances the band; a pan-end visibility recut leaves it untouched.
      if (decision.mode === "refine" && decision.nextRefinedBand !== undefined) {
        lodBand.current = decision.nextRefinedBand;
      }
      // The C1a fallback cuts (computeCut / computeGroupCut) are zoom-refine ONLY — they have no
      // eviction LRU to update on a pan. A pan-end recut therefore drives just the representation
      // path; skip the legacy paths so a pan never re-runs a zoom-shaped cut.
      const visibilityOnly = decision.mode === "visibility";
      const vp = { w: canvas.width, h: canvas.height };
      // An expanded file pulls its symbols into the layout too, so cost it as
      // 1 + symbols; collapsed/unexpanded files are a single node. Bounding the cut on
      // this (not just card count) keeps Smart's input small enough to finish in time.
      const exp = l.expanded;
      const sc = l.symbolCount;
      const nodeCost = (id: string) => 1 + (exp.has(id) ? (sc.get(id) ?? 0) : 0);

      // Phase C1b — REPRESENTATION CUT (gated behind representationLod + a snapshot). A
      // budgeted valid antichain through the proxy hierarchy (Appendix A) replaces the C1a
      // collapse-shaped cut for the rendered scene. It still hands up a GroupLodSelection via
      // onCut, so the render path is unchanged; the C1a branches below remain the fallback
      // when representationLod is off. Only a materially-different COMMITTED cut fires onCut
      // (the runtime gates the generation), and the runtime persists across recuts on the ref.
      // Directory has no snapshot prop, so it uses the canvas-built directoryRepSnapshot.
      // (`repSnap` / `willRunRepCut` were computed above to gate the box-less early-return.)
      if (willRunRepCut) {
        // MATERIAL-signature inputs (Gap 4): reference-identity tokens for the filtered graph
        // (graph ref + visible-set ref), the grouping (snapshot ref), and the per-node cost
        // inputs (expanded set + symbol-count map refs). React hands a NEW reference on a real
        // change, so these tokens change iff the material inputs do — keying the persistent
        // runtime's reuse-vs-rebuild without an O(N) content hash each recut.
        const exp = l.expanded;
        const sc = l.symbolCount;
        const filteredGraphId = `${tokenOf(l.graph)}:${tokenOf(l.visibleNodeIds)}`;
        const groupingVersion = tokenOf(repSnap);
        const nodeCostSignature = `${tokenOf(exp)}:${tokenOf(sc)}`;
        // The material signature reads only the signature inputs (not the node-id CONTENT),
        // so compute it cheaply with an empty nodeIds to decide reuse vs rebuild.
        const sigInputs = {
          snapshot: repSnap,
          boxes,
          cam: c,
          vp,
          intent: l.intent ?? new Map(),
          options: { ...DEFAULT_REP_LOD_OPTIONS, nodeCost },
          filteredGraphId,
          groupingVersion,
          nodeCostSignature,
        };
        const sig = materialSignature({ ...sigInputs, nodeIds: [] });
        const reuse = repRuntimeRef.current?.signature === sig;
        // POST-FILTER projection (Gap 7): a node is visible iff it survived the active filters.
        // Reuse the runtime's cached node-id order on a recut; only materialize a fresh node-id
        // array + visibility mask when the runtime will actually be REBUILT — never per recut.
        const visible = l.visibleNodeIds;
        const repNodeIds = reuse
          ? (repRuntimeRef.current as RepresentationRuntime).nodeIds
          : l.graph.nodes.map((n) => n.id);
        const visibleNode = (ordinal: number): boolean => visible.has(repNodeIds[ordinal]);

        // Acquire the persistent runtime: reused verbatim (no O(N) hierarchy rebuild) when the
        // signature is unchanged, rebuilt once when it changes. A camera recut takes the reuse
        // path; only a graph/filter/grouping/cost change rebuilds.
        const input = {
          ...sigInputs,
          nodeIds: repNodeIds,
          visibleNode,
          options: {
            ...DEFAULT_REP_LOD_OPTIONS,
            openPx: LOD_OPEN_PX,
            maxCards: LOD_MAX_CARDS,
            nodeBudget: LOD_NODE_BUDGET,
            nodeCost,
          },
          collectDiagnostics: !!l.onRepLod,
        };
        const runtime = acquireRepresentationRuntime(
          input,
          repRuntimeRef.current,
          LOD_OFFSCREEN_OPEN_BUDGET,
        );
        repRuntimeRef.current = runtime;
        const result = buildSceneRepresentationCut({ ...input, runtime });
        lastRep.current = result;
        l.onRepLod?.(result);
        // Only a committed generation drives a scene rebuild.
        if (result.committed) {
          // Hand up the open selection. This still feeds compose() → collapsedClusters, but ONLY
          // for legacy UI state (the cluster-collapse toggles, workspace export, the C1a fallback
          // base structure). It NO LONGER builds the production scene (design impl point 5): the
          // rendered scene is the materializer output set below, not collapseClusters(openSelection).
          l.onCut(l.groupBy, result.openSelection);

          // P1 GENERIC + INCREMENTAL materialization (design Gap 1 / Gap 9 / impl point 5). Fold the
          // committed cut into the AUTHORITATIVE production scene: intent → solver constraints →
          // LodCut → proxy materializer → scene, with NO compose()/collapseClusters() in the path.
          // The persistent fold session re-folds ONLY the changed subtrees (cost ∝ changed region);
          // it is rebuilt in lockstep with the runtime (same material signature → same hierarchy /
          // node ordinals; `l.graph` is the post-filter graph in `repNodeIds` ordinal order).
          let entry = proxySessionRef.current;
          if (!entry || entry.signature !== sig) {
            entry = {
              session: new IncrementalSceneSession(l.graph, runtime.hierarchy, { visibleNode }),
              signature: sig,
            };
            proxySessionRef.current = entry;
          }
          const folded = entry.session.recut(result.cut);
          // Adopt the folded scene as the render scene. The salt (material signature + committed
          // generation) is the layout-cache key term standing in for C1a's ser(collapsedClusters):
          // a materially-different committed cut gets a distinct cached layout.
          setRepScene({ scene: folded, cutSignature: `${sig}#${result.runtime.generation}` });
          // Optional extra consumer (telemetry / external adoption) — the production path no longer
          // depends on it, but keep the hook for callers that observe the folded scene directly.
          l.onProxyScene?.(folded);
        }
        return;
      }

      // Below here are the C1a fallback cuts (representationLod off). They are zoom-refine
      // ONLY — they carry no eviction LRU, so a pan-end recut has nothing to update in them.
      // Stop here on a visibility-only (pan) recut so a pan never re-runs a zoom-shaped cut.
      if (visibilityOnly) return;

      // Non-directory modes: run the mode-agnostic cut over the active grouping snapshot,
      // matching boxes by boxKey, and hand up the GroupLodSelection FOR that mode. (No
      // telemetry trace path — that detailed per-dir trace is Directory-specific.) Skip
      // when the raw cut is unchanged (cut-domain vs cut-domain), as the Directory path does.
      if (l.groupBy !== "directory") {
        const snap = l.groupingSnapshot;
        if (!snap) return; // no snapshot (e.g. "none") → the cut is inert this mode
        const next = computeGroupCut(
          snap,
          boxes,
          c,
          vp,
          {
            openPx: LOD_OPEN_PX,
            maxCards: LOD_MAX_CARDS,
            prevCut: l.rawCut,
            nodeBudget: LOD_NODE_BUDGET,
            nodeCost,
          },
          graph.nodes.map((n) => n.id),
        );
        if (!groupCutEquals(next, l.rawCut)) {
          l.rawCut = next;
          l.onCut(l.groupBy, groupLodSelection(next, snap));
        }
        return;
      }

      const cutOpts = {
        openPx: LOD_OPEN_PX,
        maxCards: LOD_MAX_CARDS,
        // Hysteresis is a CUT-domain decision: compare against the raw cut we last
        // produced, NOT the effective collapsedClusters prop. The effective set's redundant
        // deeper entries (a dir listed under a collapsed ancestor) would flip wasOpen() to
        // false and apply the full openPx threshold instead of the relaxed openPx*hysteresis.
        prevCut: l.rawCut,
        nodeBudget: LOD_NODE_BUDGET,
        nodeCost,
      };
      let next: Set<string>;
      // When telemetry is on, take the traced path and log everything about this cut
      // (per-dir decisions, deltas, timings); otherwise the cheap one.
      if (telemetry.isEnabled()) {
        const t0 = performance.now();
        const r = computeCutTraced(l.dirTree, boxes, c, vp, cutOpts);
        const computeMs = performance.now() - t0;
        next = r.cut;
        // Compare cut-domain to cut-domain (raw vs raw). The effective collapsedClusters
        // prop is a superset and can never equal the raw cut whenever a non-leaf dir is
        // collapsed, which would mis-report `changed` and the opened/collapsed deltas.
        const changed = !cutEquals(next, l.rawCut);
        telemetry.event("lod", "cut", {
          trigger: "zoom",
          cam: { x: c.x, y: c.y, scale: c.scale },
          band,
          prevBand,
          viewport: vp,
          openPx: LOD_OPEN_PX,
          maxCards: LOD_MAX_CARDS,
          dirsEvaluated: r.dirsEvaluated,
          dirsOnScreen: r.dirsOnScreen,
          cutSize: next.size,
          prevCutSize: l.rawCut.size,
          cards: r.cards,
          computeMs,
          changed,
          opened: [...l.rawCut].filter((p) => !next.has(p)), // collapsed → open
          collapsed: [...next].filter((p) => !l.rawCut.has(p)), // open → collapsed
          trace: r.trace,
        });
        telemetry.metric("lod.computeMs", computeMs);
        telemetry.metric("lod.cutSize", next.size);
        telemetry.metric("lod.cards", r.cards);
        telemetry.count("lod.recomputes");
        if (changed) telemetry.count("lod.cutChanges");
      } else {
        next = computeCut(l.dirTree, boxes, c, vp, cutOpts);
      }
      // The cut is still measured/decided exactly as before (a bare-path collapsed set);
      // we only change what we HAND UP. Skip when the raw cut is unchanged from the one we
      // last produced (cut-domain vs cut-domain — NOT against the effective collapsedClusters
      // prop, which the raw cut would never equal once any non-leaf dir is collapsed). Then
      // translate to the transitional DirectoryLodSelection (open directory group ids) so it
      // updates only the selection layer — never intent. Reuse the already-memoized dirTree
      // rather than rebuilding it from the raw node list on every cut.
      if (!cutEquals(next, l.rawCut)) {
        l.rawCut = next;
        l.onCut("directory", directoryLodSelection(next, l.dirTree));
      }
    };
    // Expose to the scene-ready effect so it can fire the first cut on a new scene (no gesture).
    recomputeCutRef.current = recomputeCut;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr.current;
      const py = (e.clientY - rect.top) * dpr.current;
      const c = cam.current;
      const next = Math.min(4, Math.max(minScale.current, c.scale * Math.exp(-e.deltaY * 0.0015)));
      c.x = px - ((px - c.x) / c.scale) * next;
      c.y = py - ((py - c.y) / c.scale) * next;
      c.scale = next;
      vcRef.current?.set_camera(c.x, c.y, c.scale);
      renderSoon();
      // Debounce the recompute: one cut+rebuild after the zoom gesture settles,
      // not one per wheel tick (each rebuild reprocesses the whole base graph).
      // A new wheel tick supersedes a pending pan recut — the gesture is now a zoom.
      clearTimeout(recutTimer);
      recutTimer = setTimeout(() => recomputeCut("wheel"), LOD_RECUT_DEBOUNCE_MS);
    };
    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      cam.current.x += dx * dpr.current;
      cam.current.y += dy * dpr.current;
      last = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      vcRef.current?.set_camera(cam.current.x, cam.current.y, cam.current.scale);
      renderSoon();
      // Debounce a PAN-end visibility/LRU recut (design Gap 8): each move resets the timer, so
      // it fires once the pan SETTLES — updating which proxies are on-screen + the eviction LRU
      // from the new viewport WITHOUT advancing the band (no forced deeper refinement). Without
      // this, panning an open region off-screen never updated retention / eviction.
      clearTimeout(recutTimer);
      recutTimer = setTimeout(() => recomputeCut("pan"), LOD_RECUT_DEBOUNCE_MS);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // Pointer-up ends the gesture: always cancel any pending settle-timer (a sub-threshold
      // jitter-drag may have scheduled one in onMove — see below — and we don't want it firing a
      // spurious pan recut ~200ms after what the user perceives as a click). Then, only on a real
      // pan (moved > 4px), run the pan recut NOW so retention/eviction reflect the final viewport
      // without waiting out the debounce. A click (moved ≤ 4px) panned nothing → no recut.
      clearTimeout(recutTimer);
      if (moved > 4) {
        recomputeCut("pan");
      }
      // A drag isn't a click — reset the double-click tracker so it can't pair into a double.
      if (moved > 4 || !vcRef.current) {
        lastClick.current = { id: "", time: 0 };
        return;
      }
      const rect = el.getBoundingClientRect();
      const id = vcRef.current.pick(
        (e.clientX - rect.left) * dpr.current,
        (e.clientY - rect.top) * dpr.current,
      );
      // Any action that isn't a plain card click resets the double-click tracker, so an unrelated
      // click between two card clicks can't complete an accidental double-click sequence.
      if (!id) {
        lastClick.current = { id: "", time: 0 };
        handlers.current.clearAnchors(); // empty space clears the connection highlight
        return;
      }
      if (id.startsWith("cluster:")) {
        lastClick.current = { id: "", time: 0 };
        handlers.current.onToggleCollapse(id.slice("cluster:".length)); // collapse a directory
        return;
      }
      if (id.startsWith("edge:")) {
        lastClick.current = { id: "", time: 0 };
        const edge = edgesById.current.get(id.slice("edge:".length));
        if (edge) handlers.current.onSelectEdge(edge);
        return;
      }
      if (e.shiftKey) {
        // Shift-click = path anchoring (first endpoint → second → fresh path); never expands.
        lastClick.current = { id: "", time: 0 };
        handlers.current.onAnchor(id, true);
        return;
      }
      // Plain click on a card: a SINGLE click selects + lights the card and its direct neighbors;
      // a DOUBLE click (two quick clicks on the same card) expands/collapses a file or aggregate.
      // Keeping expand off the single click means one click never swaps the card out from under
      // its own highlight.
      const now = performance.now();
      const prev = lastClick.current;
      const isDouble = id === prev.id && now - prev.time < 300;
      if (isDouble) {
        lastClick.current = { id: "", time: 0 }; // reset so a quick 3rd click isn't another double
        if (isAggregateId(id)) handlers.current.onToggleCollapse(clusterIdOfAggregate(id));
        else if (isFile.current.get(id)) handlers.current.onToggleExpand(id);
        return;
      }
      lastClick.current = { id, time: now };
      if (!isAggregateId(id)) handlers.current.onSelect(id);
      handlers.current.onAnchor(id, false); // light this card + its direct neighbors
    };
    // Esc clears the connection highlight (parallels clicking empty space).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handlers.current.clearAnchors();
    };

    // Minimap navigation: click or drag to recenter the camera on that part of the
    // graph — the fix for losing the graph when zoomed out / panned out of bounds.
    let mmDragging = false;
    const onMmDown = (e: PointerEvent) => {
      if (!minimapOn.current) return;
      e.stopPropagation();
      mmDragging = true;
      minimapRef.current?.setPointerCapture(e.pointerId);
      recenterFromMinimap(e.clientX, e.clientY);
    };
    const onMmMove = (e: PointerEvent) => {
      if (mmDragging) recenterFromMinimap(e.clientX, e.clientY);
    };
    const onMmUp = (e: PointerEvent) => {
      mmDragging = false;
      try {
        minimapRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const mm = minimapRef.current;
    mm?.addEventListener("pointerdown", onMmDown);
    mm?.addEventListener("pointermove", onMmMove);
    mm?.addEventListener("pointerup", onMmUp);

    const ro = new ResizeObserver(() => {
      if (!vcRef.current) return;
      sizeCanvas();
      vcRef.current.resize(canvas.width, canvas.height);
      renderSoon();
    });

    void (async () => {
      try {
        if (!("gpu" in navigator)) {
          setError("WebGPU is not available in this browser (need Chrome/Edge).");
          return;
        }
        sizeCanvas();
        const mod = await import("../vello-renderer/pkg/vello_renderer.js");
        await mod.default();
        if (destroyed) return;
        vcRef.current = (await mod.VelloCanvas.create(canvas)) as unknown as VelloHandle;
        if (destroyed) {
          vcRef.current.free?.();
          vcRef.current = null;
          return;
        }
        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        window.addEventListener("keydown", onKeyDown);
        ro.observe(el);
        setReady(true);
        animate();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (animRaf) cancelAnimationFrame(animRaf);
      ro.disconnect();
      clearTimeout(recutTimer);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKeyDown);
      mm?.removeEventListener("pointerdown", onMmDown);
      mm?.removeEventListener("pointermove", onMmMove);
      mm?.removeEventListener("pointerup", onMmUp);
      vcRef.current?.free?.();
      vcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed data on every payload change, but re-fit the camera ONLY when the scene structure
  // actually changed for a fit-worthy reason (new graph/level/filters) — not on an adaptive recut
  // (which preserves the user's zoom), nor on a highlight/dim payload change that keeps the same
  // scene (a click, the focus-fade).
  const prevFitSig = useRef<string | undefined>(undefined);
  const prevScene = useRef<Scene | null>(null);
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_data(payload);
    // Re-fit only when a new layout for a fit-worthy structure has actually landed: the scene
    // object changed, the layout is READY for the current structure (positions match it, not a
    // half-applied scene mid-transition with new nodes still at 0,0), and the fit signature
    // changed. Highlight/dim and the marching-ants phase keep the same scene; an adaptive recut
    // keeps the same fitSignature — so none of them yank the camera. prevFitSig advances ONLY on
    // an actual fit, so when positions lag the structure by a render the fit still fires the
    // moment they arrive (instead of locking onto the degenerate intermediate scene).
    const sceneChanged = scene !== prevScene.current;
    prevScene.current = scene;
    if (sceneChanged && layoutReady && shouldFit(fitSignature, prevFitSig.current)) {
      const fit = vc.fit();
      cam.current = { x: fit[0], y: fit[1], scale: fit[2] };
      // Allow zooming out to the fit scale (or the normal 0.02 floor, whichever is smaller) so
      // large graphs aren't stuck zoomed in — but never below 0.004, so a stray/oversized fit
      // can't let the user zoom out to a useless sub-pixel speck. (Adaptive LOD thins the card
      // count at low zoom, so you never need to zoom past this to see the whole graph.)
      minScale.current = Math.max(0.004, Math.min(fit[2], 0.02));
      lodBand.current = cameraBand(cam.current.scale);
      prevFitSig.current = fitSignature;
    } else {
      // Highlight/dim, an adaptive recut, or a layout not yet ready: keep the user's camera.
      vc.set_camera(cam.current.x, cam.current.y, cam.current.scale);
    }
    vc.set_selection(effectiveSelectionId);
    vc.set_search(search);
    if (telemetry.isEnabled()) {
      const t0 = performance.now();
      vc.render();
      const renderMs = performance.now() - t0;
      let stats: Record<string, unknown> = {};
      try {
        stats = JSON.parse(vc.stats());
      } catch {
        /* ignore */
      }
      telemetry.event("render", "scene", {
        payloadBytes: payload.length,
        nodes: scene.nodes.length,
        edges: scene.edges.length,
        clusters: scene.clusters.length,
        renderMs,
        ...stats, // nodesDrawn/culled, edgesEncoded, clustersDrawn, …
      });
      telemetry.metric("render.sceneMs", renderMs);
      telemetry.metric("render.payloadBytes", payload.length);
    } else {
      vc.render();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, payload, fitSignature, scene, layoutReady]);

  // INITIAL / refresh rep cut (design impl point 5). The mount-effect's recomputeCut fires only on
  // camera gestures, so without this the authoritative materializer path would never run until the
  // user zooms/pans — the bootstrap C1a base scene would render indefinitely. When a fresh
  // layout-ready scene lands (a new graph / filter / grouping / the rep scene itself), fire one cut
  // so the committed cut is materialized into the production scene. The solver's committed-generation
  // guard makes this idempotent: re-running the SAME committed cut returns committed=false, so
  // folding the rep scene's own re-layout does NOT loop (no second setRepScene). Skipped while the
  // rep cut is off (the C1a path renders directly) and until recomputeCut is installed.
  const lastCutScene = useRef<Scene | null>(null);
  useEffect(() => {
    if (!representationLod || !ready || !layoutReady) return;
    if (scene === lastCutScene.current) return; // same scene (highlight/dim only) — nothing to recut
    lastCutScene.current = scene;
    // "pan" (visibility) ALWAYS runs the cut (no band-advance requirement) without forcing deeper
    // refinement — exactly what an initial / post-change materialization needs. A real zoom still
    // refines via the wheel handler.
    recomputeCutRef.current?.("pan");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [representationLod, ready, layoutReady, scene]);

  // Selection / search are cheap — just update + redraw.
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_selection(effectiveSelectionId);
    vc.set_search(search);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, effectiveSelectionId, search]);

  // On search, frame the matching nodes so a match is visible even when zoomed out
  // (keeps the renderer's yellow match outline). No match → leave the camera put.
  useEffect(() => {
    const vc = vcRef.current;
    const canvas = canvasRef.current;
    if (!ready || !vc || !canvas) return;
    const q = search.trim().toLowerCase();
    if (!q) return;
    const boxes = scene.nodes
      .filter((n) => n.label.toLowerCase().includes(q))
      .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
    const target = frameBoxes(boxes, canvas.width, canvas.height);
    if (!target) return;
    cam.current = target;
    vc.set_camera(target.x, target.y, target.scale);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, search]);

  // In highlight mode, frame the matched nodes so they're on screen even when the
  // full graph is large. Empty match → leave the camera where it is.
  useEffect(() => {
    const vc = vcRef.current;
    const canvas = canvasRef.current;
    if (!ready || !vc || !canvas || !highlightIds || highlightIds.size === 0) return;
    const boxes = scene.nodes
      .filter((n) => highlightIds.has(n.id))
      .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
    const target = frameBoxes(boxes, canvas.width, canvas.height);
    if (!target) return;
    cam.current = target;
    vc.set_camera(target.x, target.y, target.scale);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, highlightIds, payload]);

  // Match the canvas palette to the app's light/dark mode.
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_theme(resolvedTheme !== "light");
    vc.render();
  }, [ready, resolvedTheme]);

  // Redraw the minimap when the scene (extent) or toggle changes — camera moves
  // already redraw it via renderSoon.
  useEffect(() => {
    drawMinimapRef.current?.();
  }, [scene, minimap, ready]);

  return (
    <Box position="absolute" inset="0" ref={containerRef} overflow="hidden">
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <canvas
        ref={minimapRef}
        aria-label="Minimap"
        style={{
          position: "absolute",
          right: 12,
          bottom: 12,
          width: 200,
          height: 140,
          display: minimap ? "block" : "none",
          borderRadius: 8,
          border: "1px solid var(--chakra-colors-border)",
          background: "var(--chakra-colors-bg-panel)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          cursor: "crosshair",
          touchAction: "none",
        }}
      />
      {layingOut && <LayoutOverlay />}
      {connStatus && (
        <Box
          position="absolute"
          top="3"
          left="50%"
          transform="translateX(-50%)"
          maxW="90%"
          truncate
          fontSize="sm"
          px="3"
          py="1.5"
          rounded="md"
          borderWidth="1px"
          borderColor="border"
          bg={connStatus.ok ? "bg.panel" : "orange.subtle"}
          color={connStatus.ok ? "fg" : "orange.fg"}
        >
          {connStatus.text}
        </Box>
      )}
      {fallbackNote && (
        <Box
          position="absolute"
          bottom="3"
          left="3"
          maxW="60%"
          truncate
          bg="orange.subtle"
          color="orange.fg"
          fontSize="xs"
          px="3"
          py="1.5"
          rounded="md"
          borderWidth="1px"
          borderColor="border"
          title={fallbackNote}
        >
          {fallbackNote}
        </Box>
      )}
      {error && (
        <Box
          position="absolute"
          top="3"
          left="3"
          bg="red.subtle"
          color="red.fg"
          fontSize="xs"
          px="3"
          py="1.5"
          rounded="md"
        >
          {error}
        </Box>
      )}
    </Box>
  );
}
