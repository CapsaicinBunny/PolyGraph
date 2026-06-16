"use client";

import { useEffect, useMemo, useRef } from "react";
import { Box } from "@chakra-ui/react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { Scene, SceneFilters } from "@/lib/graph/scene";
import type { ViewEdgeKind } from "@/lib/aggregate";
import type { Environment, GraphModel, NodeCategory, NodeKind, Runtime } from "@/lib/graph/types";
import type { LayoutAlgorithm, LayoutDirection } from "@/lib/layout";
import { LayoutOverlay } from "./LayoutOverlay";
import { useScene } from "./useScene";

const PANEL_FILL = 0x1c1f26;
const BORDER = 0x3b414c;
const LABEL_MIN_SCALE = 0.45; // below this zoom, labels are hidden (overview mode)
const MAX_LABELS = 400; // cap label objects for performance
const LABEL_COLOR = "#e2e8f0";
const SELECT_COLOR = 0x60a5fa;
const MATCH_COLOR = 0xfacc15;

function hexToNum(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16) || 0x94a3b8;
}

interface PixiGraphCanvasProps {
  graph: GraphModel;
  expanded: Set<string>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  search: string;
  selectedId: string | null;
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  showExternal: boolean;
  enabledNodeKinds: Set<NodeKind>;
  enabledCategories: Set<NodeCategory>;
  enabledEnvironments: Set<Environment>;
  enabledRuntimes: Set<Runtime>;
  onSelect: (id: string) => void;
  onToggleExpand: (fileId: string) => void;
}

interface PixiRefs {
  app: Application;
  world: Container;
  edgesG: Graphics;
  nodesG: Graphics;
  highlightG: Graphics;
  labelLayer: Container;
  labelPool: Text[];
}

export function PixiGraphCanvas(props: PixiGraphCanvasProps) {
  const {
    graph,
    expanded,
    enabledEdgeKinds,
    search,
    selectedId,
    algorithm,
    direction,
    showExternal,
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
    onSelect,
    onToggleExpand,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const refs = useRef<PixiRefs | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const selectionRef = useRef<{ selectedId: string | null; search: string }>({
    selectedId: null,
    search: "",
  });
  // Callbacks change every render; read them through a ref so listeners stay stable.
  const handlersRef = useRef({ onSelect, onToggleExpand });
  handlersRef.current = { onSelect, onToggleExpand };

  const filters: SceneFilters = useMemo(
    () => ({
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
    }),
    [
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
    ],
  );

  const { scene, layingOut } = useScene(graph, expanded, filters, algorithm, direction);

  // --- drawing helpers (read live refs/scene; no React deps) ---
  const drawScene = () => {
    const r = refs.current;
    const s = sceneRef.current;
    if (!r || !s) return;

    const byId = new Map(s.nodes.map((n) => [n.id, n]));
    r.edgesG.clear();
    for (const e of s.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      r.edgesG
        .moveTo(a.x + a.width / 2, a.y + a.height / 2)
        .lineTo(b.x + b.width / 2, b.y + b.height / 2)
        .stroke({ width: 1.25, color: hexToNum(e.color), alpha: e.dashed ? 0.4 : 0.7 });
    }

    r.nodesG.clear();
    for (const n of s.nodes) {
      const accent = hexToNum(n.color);
      // Card: dark panel + subtle border (matches the React Flow node).
      r.nodesG
        .roundRect(n.x, n.y, n.width, n.height, 6)
        .fill({ color: PANEL_FILL, alpha: 1 })
        .stroke({ width: 1, color: BORDER, alpha: 1 });
      // Colored left accent bar.
      r.nodesG.roundRect(n.x, n.y, 4, n.height, 2).fill({ color: accent, alpha: 1 });
    }
    drawHighlight();
  };

  const drawHighlight = () => {
    const r = refs.current;
    const s = sceneRef.current;
    if (!r || !s) return;
    const { selectedId: sel, search: q } = selectionRef.current;
    const query = q.trim().toLowerCase();
    r.highlightG.clear();

    if (query) {
      let count = 0;
      for (const n of s.nodes) {
        if (count >= 250) break;
        if (n.label.toLowerCase().includes(query)) {
          r.highlightG
            .roundRect(n.x - 2, n.y - 2, n.width + 4, n.height + 4, 7)
            .stroke({ width: 2, color: MATCH_COLOR, alpha: 0.9 });
          count++;
        }
      }
    }
    if (sel) {
      const n = s.nodes.find((node) => node.id === sel);
      if (n)
        r.highlightG
          .roundRect(n.x - 2, n.y - 2, n.width + 4, n.height + 4, 7)
          .stroke({ width: 2.5, color: SELECT_COLOR, alpha: 1 });
    }
  };

  const updateLabels = () => {
    const r = refs.current;
    const s = sceneRef.current;
    if (!r || !s) return;
    const { world, app, labelLayer, labelPool } = r;
    const scale = world.scale.x;

    if (scale < LABEL_MIN_SCALE) {
      labelLayer.visible = false;
      return;
    }
    labelLayer.visible = true;

    // Visible world bounds, so we only label what's on screen.
    const left = -world.x / scale;
    const top = -world.y / scale;
    const right = left + app.screen.width / scale;
    const bottom = top + app.screen.height / scale;

    let used = 0;
    for (const n of s.nodes) {
      if (used >= MAX_LABELS) break;
      if (n.x > right || n.x + n.width < left || n.y > bottom || n.y + n.height < top) continue;
      let text = labelPool[used];
      if (!text) {
        text = new Text({
          text: "",
          style: { fill: LABEL_COLOR, fontSize: 12, fontFamily: "sans-serif" },
        });
        labelPool[used] = text;
        labelLayer.addChild(text);
      }
      const badge = n.isFile && n.symbolCount > 0 ? `  +${n.symbolCount}` : "";
      text.text = `${n.glyph}  ${n.label}${badge}`;
      text.position.set(n.x + 12, n.y + n.height / 2 - 7);
      text.visible = true;
      used++;
    }
    for (let i = used; i < labelPool.length; i++) labelPool[i].visible = false;
  };

  const fitView = () => {
    const r = refs.current;
    const s = sceneRef.current;
    if (!r || !s || s.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of s.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const w = r.app.screen.width;
    const h = r.app.screen.height;
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const scale = Math.min(w / contentW, h / contentH, 1.5) * 0.9;
    r.world.scale.set(scale);
    r.world.x = w / 2 - ((minX + maxX) / 2) * scale;
    r.world.y = h / 2 - ((minY + maxY) / 2) * scale;
    updateLabels();
  };

  // --- one-time Pixi setup ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let destroyed = false;
    let rafId = 0;
    const app = new Application();

    const scheduleLabels = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateLabels();
      });
    };

    let dragging = false;
    let last = { x: 0, y: 0 };
    let moved = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = refs.current;
      if (!r) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const old = r.world.scale.x;
      const next = Math.min(3, Math.max(0.02, old * Math.exp(-e.deltaY * 0.0015)));
      const wx = (px - r.world.x) / old;
      const wy = (py - r.world.y) / old;
      r.world.scale.set(next);
      r.world.x = px - wx * next;
      r.world.y = py - wy * next;
      scheduleLabels();
    };
    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const r = refs.current;
      if (!r) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      r.world.x += dx;
      r.world.y += dy;
      last = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      scheduleLabels();
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (moved > 4) return; // it was a pan, not a click
      const r = refs.current;
      const s = sceneRef.current;
      if (!r || !s) return;
      const rect = el.getBoundingClientRect();
      const scale = r.world.scale.x;
      const wx = (e.clientX - rect.left - r.world.x) / scale;
      const wy = (e.clientY - rect.top - r.world.y) / scale;
      // Topmost node under the point.
      for (let i = s.nodes.length - 1; i >= 0; i--) {
        const n = s.nodes[i];
        if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
          if (n.isFile) handlersRef.current.onToggleExpand(n.id);
          handlersRef.current.onSelect(n.id);
          break;
        }
      }
    };

    app
      .init({
        resizeTo: el,
        antialias: true,
        backgroundAlpha: 0,
        preference: "webgpu", // WebGPU when available, WebGL fallback
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      })
      .then(() => {
        if (destroyed) {
          app.destroy(true, { children: true });
          return;
        }
        el.appendChild(app.canvas);
        const world = new Container();
        app.stage.addChild(world);
        const edgesG = new Graphics();
        const nodesG = new Graphics();
        const highlightG = new Graphics();
        const labelLayer = new Container();
        world.addChild(edgesG, nodesG, highlightG, labelLayer);
        refs.current = { app, world, edgesG, nodesG, highlightG, labelLayer, labelPool: [] };

        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("pointerdown", onPointerDown);
        el.addEventListener("pointermove", onPointerMove);
        el.addEventListener("pointerup", onPointerUp);

        drawScene();
        fitView();
      })
      .catch(() => {
        /* init failed; renderer unavailable */
      });

    return () => {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      refs.current?.app.destroy(true, { children: true });
      refs.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw + refit when the scene (geometry) changes.
  useEffect(() => {
    sceneRef.current = scene;
    if (!refs.current) return;
    drawScene();
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Cheap: update highlight overlay on selection/search change.
  useEffect(() => {
    selectionRef.current = { selectedId, search };
    drawHighlight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, search]);

  return (
    <>
      <Box ref={containerRef} position="absolute" inset="0" overflow="hidden" />
      {layingOut && <LayoutOverlay />}
    </>
  );
}
