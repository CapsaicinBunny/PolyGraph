"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { clusterIdOfAggregate, isAggregateId } from "@/lib/graph/collapse";
import type { Scene, SceneEdge, SceneFilters } from "@/lib/graph/scene";
import type { Environment, GraphModel, NodeCategory, NodeKind, Runtime } from "@/lib/graph/types";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "@/lib/layout";
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
// Debounce the adaptive recompute so a single zoom *gesture* (many wheel ticks
// across bands) triggers ONE cut+rebuild after it settles — not one per tick. The
// rebuild reprocesses the whole base graph (1.39M nodes on the kernel), so coalescing
// is the difference between a usable zoom and a multi-second-per-frame freeze.
const LOD_RECUT_DEBOUNCE_MS = 200;

export interface GraphViewProps {
  graph: GraphModel;
  expanded: Set<string>;
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
  const handlers = useRef({ onSelect, onToggleExpand, onToggleCollapse, onSelectEdge });
  handlers.current = { onSelect, onToggleExpand, onToggleCollapse, onSelectEdge };
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
  }>({ adaptiveLod, onCut, dirTree, scene, collapsed: collapsedClusters });
  lod.current.adaptiveLod = adaptiveLod;
  lod.current.onCut = onCut;
  lod.current.dirTree = dirTree;
  lod.current.scene = scene;
  lod.current.collapsed = collapsedClusters;
  const lodBand = useRef(cameraBand(1));

  // The JSON payload Vello consumes. Built from the positioned scene.
  const payload = useMemo(() => {
    // In highlight mode, mute everything outside the match set so the matches pop.
    const dim = (id: string) => highlightIds != null && !highlightIds.has(id);
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
      color: dim(n.id) ? DIM_RGB : hexToRgb(n.color),
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
        const muted = dim(e.source) || dim(e.target);
        return {
          id: e.id,
          x1: a[0],
          y1: a[1],
          x2: b[0],
          y2: b[1],
          color: muted ? DIM_RGB : hexToRgb(e.color),
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
  }, [scene, edgeRouting, highlightIds]);

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
      const cutOpts = { openPx: LOD_OPEN_PX, maxCards: LOD_MAX_CARDS, prevCut: l.collapsed };
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
      if (moved > 4 || !vcRef.current) return;
      const rect = el.getBoundingClientRect();
      const id = vcRef.current.pick(
        (e.clientX - rect.left) * dpr.current,
        (e.clientY - rect.top) * dpr.current,
      );
      if (id) {
        if (id.startsWith("cluster:")) {
          handlers.current.onToggleCollapse(id.slice("cluster:".length)); // collapse a directory
        } else if (id.startsWith("edge:")) {
          const edge = edgesById.current.get(id.slice("edge:".length));
          if (edge) handlers.current.onSelectEdge(edge);
        } else if (isAggregateId(id)) {
          handlers.current.onToggleCollapse(clusterIdOfAggregate(id)); // expand an aggregate card
        } else {
          if (isFile.current.get(id)) handlers.current.onToggleExpand(id);
          handlers.current.onSelect(id);
        }
      }
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
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_data(payload);
    if (shouldFit(fitSignature, prevFitSig.current)) {
      const fit = vc.fit();
      cam.current = { x: fit[0], y: fit[1], scale: fit[2] };
      // Match the renderer's dynamic floor: allow zooming out to the fit scale (or the
      // normal floor, whichever is smaller) so large graphs aren't stuck zoomed in.
      minScale.current = Math.min(fit[2], 0.02);
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
  }, [ready, payload, fitSignature]);

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
