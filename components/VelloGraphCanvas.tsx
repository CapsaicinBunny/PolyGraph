"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { clusterIdOfAggregate, isAggregateId } from "@/lib/graph/collapse";
import {
  buildAdjacency,
  connectionHighlight,
  connectionStatus,
  nextAnchors,
  pairKey,
  pruneAnchors,
} from "@/lib/graph/connections";
import type { Scene, SceneEdge, SceneFilters } from "@/lib/graph/scene";
import type { Environment, GraphModel, NodeCategory, NodeKind, Runtime } from "@/lib/graph/types";
import {
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
  layoutFallbackSummary,
} from "@/lib/layout";
import { frameBoxes } from "@/lib/graph/frame";
import { buildDirTree, type DirNode } from "@/lib/graph/hierarchy";
import { computeCut, computeCutTraced, cutEquals } from "@/lib/graph/lod-cut";
import { cameraBand, sceneBoxes, shouldFit } from "@/lib/graph/lod-scene";
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
// Cap on estimated layout NODES (files + their symbols when expanded). Smart lays out
// ~2.5k dense nodes in ~1s but ~40s at 29k, so keep the cut's input under this and
// Smart always finishes within the worker timeout (never degrading to the grid
// fallback). See docs/superpowers/plans/2026-06-18-nanite-lod-node-budget.md.
const LOD_NODE_BUDGET = 2500;
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
  enabledNodeKinds: Set<NodeKind>;
  enabledCategories: Set<NodeCategory>;
  enabledEnvironments: Set<Environment>;
  enabledRuntimes: Set<Runtime>;
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
  onSelect: (id: string) => void;
  onToggleExpand: (fileId: string) => void;
  onToggleCollapse: (clusterId: string) => void;
  onSelectEdge: (edge: SceneEdge) => void;
  /** Show the navigation minimap overlay (graph extent + viewport rect). */
  minimap?: boolean;
  /** Adaptive level-of-detail: recompute the collapsed cut as the camera zooms. */
  adaptiveLod?: boolean;
  /** Called with a new collapsed-directory set when the adaptive cut changes. */
  onCut?: (collapsed: Set<string>) => void;
  /**
   * Signature of everything that warrants re-framing the camera (graph, level,
   * filters) but NOT the cut. When it's unchanged across a scene update, the
   * camera is preserved instead of re-fitting — so an adaptive recut doesn't
   * yank the view. Undefined (the default) always re-fits: today's behavior.
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
// Connection-highlight ring colors, drawn as an OUTLINE only (the card keeps its own
// kind-color so its type still reads): the path's start, its destination, and the nodes
// in between. Blue start matches the selection outline.
const CONN_START_RGB: [number, number, number] = [59, 130, 246]; // blue
const CONN_END_RGB: [number, number, number] = [239, 68, 68]; // red
const CONN_PATH_RGB: [number, number, number] = [234, 179, 8]; // yellow

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
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
    enabledFolders,
    enabledLanguages,
    collapsedClusters,
    communityCollapse,
    edgeRouting,
    focusedIds,
    queryIds,
    highlightIds,
    projected,
    onSelect,
    onToggleExpand,
    onToggleCollapse,
    onSelectEdge,
    minimap = true,
    adaptiveLod,
    onCut,
    fitSignature,
  } = props;

  const filters: SceneFilters = useMemo(
    () => ({
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
      enabledFolders,
      enabledLanguages,
    }),
    [
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
      enabledFolders,
      enabledLanguages,
    ],
  );

  const { scene, layingOut } = useScene(
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
  );
  const { resolvedTheme } = useTheme();

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

  // Adaptive level-of-detail state the (mount-time) wheel handler reads via refs.
  const dirTree = useMemo(() => buildDirTree(graph), [graph]);
  const lod = useRef<{
    adaptiveLod?: boolean;
    onCut?: (c: Set<string>) => void;
    dirTree: DirNode;
    scene: Scene;
    collapsed: Set<string>;
    expanded: Set<string>;
    symbolCount: Map<string, number>;
    groupBy: GroupBy;
  }>({
    adaptiveLod,
    onCut,
    dirTree,
    scene,
    collapsed: collapsedClusters,
    expanded,
    symbolCount,
    groupBy,
  });
  lod.current.adaptiveLod = adaptiveLod;
  lod.current.onCut = onCut;
  lod.current.dirTree = dirTree;
  lod.current.scene = scene;
  lod.current.collapsed = collapsedClusters;
  lod.current.expanded = expanded;
  lod.current.symbolCount = symbolCount;
  lod.current.groupBy = groupBy;
  const lodBand = useRef(cameraBand(1));

  // The JSON payload Vello consumes. Built from the positioned scene.
  const payload = useMemo(() => {
    // Mute everything outside the highlight set so the matches pop. Nodes dim by membership.
    const dimNode = (id: string) => effectiveHighlight != null && !effectiveHighlight.has(id);
    // Connection roles → an outline ring (not a fill): first anchor = start (blue), last anchor
    // = destination (red), nodes between them on the path = yellow. Outline-only keeps each
    // card's kind-color intact, so the ring reads as "role" rather than "different type".
    const connStart = conn ? liveAnchors[0] : undefined;
    const connEnd =
      conn && liveAnchors.length > 1 ? liveAnchors[liveAnchors.length - 1] : undefined;
    const connMiddle = conn?.path && conn.path.length > 2 ? new Set(conn.path.slice(1, -1)) : null;
    const outlineFor = (id: string): [number, number, number] | undefined => {
      if (!conn) return undefined;
      if (id === connStart) return CONN_START_RGB;
      if (id === connEnd) return CONN_END_RGB;
      if (connMiddle?.has(id)) return CONN_PATH_RGB;
      return undefined;
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
    const nodes = scene.nodes.map((n) => ({
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
    // decision matches exactly what the user sees. No-op unless adaptiveLod is on or
    // the zoom band hasn't actually changed since the last cut.
    const recomputeCut = () => {
      const l = lod.current;
      if (!l.adaptiveLod || !l.onCut) return;
      // The cut walks the DIRECTORY tree and measures boxes keyed by dir path. Under
      // Community grouping the scene's boxes are keyed by community id (no dir match) so
      // every dir would read as off-screen and the cut would wrongly collapse the whole
      // view; under "none" there are no cluster boxes at all. The adaptive cut only makes
      // sense for Directory grouping — leave the other modes' layouts alone.
      if (l.groupBy !== "directory") return;
      // The cut measures each directory's on-screen size from the layout's cluster
      // boxes. The grid fallback (forced on large/dense graphs) and groupBy:"none"
      // produce NO clusters, so every dir reads as "off-screen, height 0" and the cut
      // would wrongly collapse the whole graph to a few aggregates (the disappearing
      // view). With no clusters to measure, leave the cut alone.
      if (l.scene.clusters.length === 0) return;
      const c = cam.current;
      const band = cameraBand(c.scale);
      // Monotonic LOD: only ever REFINE (open more detail) as the user zooms IN —
      // never re-collapse on zoom-OUT. Collapsing the view you're looking at when you
      // zoom out is the disliked behavior; once a region is opened it stays open. The
      // cut resets (re-fits lodBand) on a new scan / expand / collapse-all. computeCut
      // still caps the result at maxCards, so the open set stays bounded.
      if (band <= lodBand.current) return;
      const prevBand = lodBand.current;
      lodBand.current = band;
      const boxes = sceneBoxes(l.scene);
      const vp = { w: canvas.width, h: canvas.height };
      // An expanded file pulls its symbols into the layout too, so cost it as
      // 1 + symbols; collapsed/unexpanded files are a single node. Bounding the cut on
      // this (not just card count) keeps Smart's input small enough to finish in time.
      const exp = l.expanded;
      const sc = l.symbolCount;
      const nodeCost = (id: string) => 1 + (exp.has(id) ? (sc.get(id) ?? 0) : 0);
      const cutOpts = {
        openPx: LOD_OPEN_PX,
        maxCards: LOD_MAX_CARDS,
        prevCut: l.collapsed,
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
        const changed = !cutEquals(next, l.collapsed);
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
          prevCutSize: l.collapsed.size,
          cards: r.cards,
          computeMs,
          changed,
          opened: [...l.collapsed].filter((p) => !next.has(p)), // collapsed → open
          collapsed: [...next].filter((p) => !l.collapsed.has(p)), // open → collapsed
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
      if (!cutEquals(next, l.collapsed)) l.onCut(next);
    };

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
      clearTimeout(recutTimer);
      recutTimer = setTimeout(recomputeCut, LOD_RECUT_DEBOUNCE_MS);
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
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
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

  // Feed data when the scene changes, and re-fit the camera only when the scene
  // changed for a fit-worthy reason (new graph/level/filters) — NOT when only the
  // adaptive cut changed, so a recut preserves the user's zoom. With adaptiveLod
  // off, fitSignature is undefined and this always fits: today's behavior.
  const prevFitSig = useRef<string | undefined>(undefined);
  const prevScene = useRef<Scene | null>(null);
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_data(payload);
    // Only the SCENE STRUCTURE changing (new layout/filter) warrants a re-fit. The payload also
    // changes for highlight/dim (a click, the focus-fade) and the marching-ants phase — those must
    // NOT yank the camera. Critical when adaptiveLod is off, where fitSignature is undefined and
    // shouldFit() is always true: without this gate every click re-fit to min zoom.
    const sceneChanged = scene !== prevScene.current;
    prevScene.current = scene;
    if (sceneChanged && shouldFit(fitSignature, prevFitSig.current)) {
      const fit = vc.fit();
      cam.current = { x: fit[0], y: fit[1], scale: fit[2] };
      // Allow zooming out to the fit scale (or the normal 0.02 floor, whichever is smaller) so
      // large graphs aren't stuck zoomed in — but never below 0.004, so a stray/oversized fit
      // can't let the user zoom out to a useless sub-pixel speck. (Adaptive LOD thins the card
      // count at low zoom, so you never need to zoom past this to see the whole graph.)
      minScale.current = Math.max(0.004, Math.min(fit[2], 0.02));
      lodBand.current = cameraBand(cam.current.scale);
    } else {
      // Cut-only change: keep the camera where the user left it.
      vc.set_camera(cam.current.x, cam.current.y, cam.current.scale);
    }
    prevFitSig.current = fitSignature;
    vc.set_selection(selectedId ?? undefined);
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
  }, [ready, payload, fitSignature, scene]);

  // Selection / search are cheap — just update + redraw.
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_selection(selectedId ?? undefined);
    vc.set_search(search);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId, search]);

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
