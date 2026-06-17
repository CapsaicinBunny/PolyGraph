"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { clusterIdOfAggregate, isAggregateId } from "@/lib/graph/collapse";
import type { SceneEdge, SceneFilters } from "@/lib/graph/scene";
import type { Environment, GraphModel, NodeCategory, NodeKind, Runtime } from "@/lib/graph/types";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "@/lib/layout";
import { frameBoxes } from "@/lib/graph/frame";
import { LayoutOverlay } from "./LayoutOverlay";
import { useScene } from "./useScene";

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
  onSelect: (id: string) => void;
  onToggleExpand: (fileId: string) => void;
  onToggleCollapse: (clusterId: string) => void;
  onSelectEdge: (edge: SceneEdge) => void;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Muted gray for nodes/edges outside the highlight set (readable in both themes).
const DIM_RGB: [number, number, number] = [90, 99, 112];

interface VelloHandle {
  set_data: (json: string) => void;
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
    onSelect,
    onToggleExpand,
    onToggleCollapse,
    onSelectEdge,
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
  );
  const { resolvedTheme } = useTheme();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vcRef = useRef<VelloHandle | null>(null);
  const cam = useRef({ x: 0, y: 0, scale: 1 });
  const dpr = useRef(1);
  const isFile = useRef(new Map<string, boolean>());
  const edgesById = useRef(new Map<string, SceneEdge>());
  edgesById.current = new Map(scene.edges.map((e) => [e.id, e]));
  const handlers = useRef({ onSelect, onToggleExpand, onToggleCollapse, onSelectEdge });
  handlers.current = { onSelect, onToggleExpand, onToggleCollapse, onSelectEdge };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    const renderSoon = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        vcRef.current?.render();
      });
    };

    // Marching-ants animation: advance the dash phase + redraw each frame, but
    // only while zoomed in enough to perceive it (keeps the zoomed-out case — where
    // the whole graph is on screen — cheap, since dashes are sub-pixel there anyway).
    const ANIM_MIN_SCALE = 0.35;
    let animRaf = 0;
    let phase = 0;
    const animate = () => {
      animRaf = requestAnimationFrame(animate);
      const vc = vcRef.current;
      if (!vc || cam.current.scale < ANIM_MIN_SCALE) return;
      phase = (phase + 0.6) % 12;
      vc.set_phase(-phase);
      vc.render();
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

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) * dpr.current;
      const py = (e.clientY - rect.top) * dpr.current;
      const c = cam.current;
      const next = Math.min(4, Math.max(0.02, c.scale * Math.exp(-e.deltaY * 0.0015)));
      c.x = px - ((px - c.x) / c.scale) * next;
      c.y = py - ((py - c.y) / c.scale) * next;
      c.scale = next;
      vcRef.current?.set_camera(c.x, c.y, c.scale);
      renderSoon();
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
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      vcRef.current?.free?.();
      vcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed data + fit when the scene geometry changes.
  useEffect(() => {
    const vc = vcRef.current;
    if (!ready || !vc) return;
    vc.set_data(payload);
    const fit = vc.fit();
    cam.current = { x: fit[0], y: fit[1], scale: fit[2] };
    vc.set_selection(selectedId ?? undefined);
    vc.set_search(search);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, payload]);

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

  return (
    <Box position="absolute" inset="0" ref={containerRef} overflow="hidden">
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
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
