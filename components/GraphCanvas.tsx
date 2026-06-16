"use client";

import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildView, type ViewEdgeKind } from "@/lib/aggregate";
import type {
  Environment,
  ExternalKind,
  GraphModel,
  NodeCategory,
  NodeKind,
  NodeRole,
  Runtime,
} from "@/lib/graph/types";
import { EDGE_STYLES, nodeStyle } from "@/lib/graph/visual";
import {
  DIRECTIONAL_ALGORITHMS,
  type LayoutAlgorithm,
  type LayoutDirection,
  layoutViewCached,
} from "@/lib/layout";
import { GraphFlowNode } from "./nodes/GraphFlowNode";

const nodeTypes = { graph: GraphFlowNode };

// Scale guards: above these counts the cost outweighs the benefit, so we drop them.
const ANIMATE_EDGE_LIMIT = 250; // animated edges cause a repaint storm at scale
const MINIMAP_NODE_LIMIT = 600; // the minimap re-draws every node

// Stable per-analysis id, so the layout cache signature can't collide across scans.
let graphCounter = 0;
const graphIds = new WeakMap<object, string>();
function graphKeyFor(graph: GraphModel): string {
  let id = graphIds.get(graph);
  if (!id) {
    graphCounter += 1;
    id = String(graphCounter);
    graphIds.set(graph, id);
  }
  return id;
}

function ser<T>(set: Set<T>): string {
  return [...set].map(String).sort().join(",");
}

interface GraphCanvasProps {
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

function GraphCanvasInner({
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
}: GraphCanvasProps) {
  const { fitView } = useReactFlow();

  // Expensive layer: filter -> view -> layout. Recomputes ONLY when something that
  // changes geometry changes (NOT on selection/search), and the layout itself is cached.
  const base = useMemo(() => {
    const visible = (n: GraphModel["nodes"][number]) => {
      if (n.kind === "external") return showExternal;
      if (n.environment && !enabledEnvironments.has(n.environment)) return false;
      if (n.runtimes?.length && !n.runtimes.some((r) => enabledRuntimes.has(r))) return false;
      if (n.kind === "file") return true;
      return enabledNodeKinds.has(n.kind) && (!n.category || enabledCategories.has(n.category));
    };
    const keptIds = new Set(graph.nodes.filter(visible).map((n) => n.id));
    const sourceGraph = {
      nodes: graph.nodes.filter(visible),
      edges: graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
    };
    const view = buildView(sourceGraph, expanded);
    const visibleEdges = view.edges.filter(
      (e) => e.kind === "contains" || enabledEdgeKinds.has(e.kind),
    );

    const signature = [
      graphKeyFor(graph),
      algorithm,
      direction,
      `x${showExternal ? 1 : 0}`,
      ser(expanded),
      ser(enabledNodeKinds),
      ser(enabledCategories),
      ser(enabledEnvironments),
      ser(enabledRuntimes),
      ser(enabledEdgeKinds),
    ].join("|");
    const positions = layoutViewCached(
      signature,
      { nodes: view.nodes, edges: visibleEdges },
      {
        algorithm,
        direction,
      },
    );

    const handleDirection = DIRECTIONAL_ALGORITHMS.includes(algorithm) ? direction : "LR";

    const symbolCount = new Map<string, number>();
    for (const n of graph.nodes) {
      if (n.kind !== "file")
        symbolCount.set(n.parentFile, (symbolCount.get(n.parentFile) ?? 0) + 1);
    }

    const externalColor = new Map<string, string>();
    for (const n of view.nodes) {
      if (n.kind === "external")
        externalColor.set(n.id, nodeStyle(n.kind, n.role, n.externalKind).color);
    }

    const animate = visibleEdges.length <= ANIMATE_EDGE_LIMIT;
    const rfEdges: Edge[] = visibleEdges.map((e) => {
      const style = EDGE_STYLES[e.kind as ViewEdgeKind];
      const dashed = e.kind === "contains";
      const toExternal = externalColor.get(e.target);
      const color = toExternal ?? style.color;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: animate && e.kind !== "contains",
        style: {
          stroke: color,
          strokeWidth: dashed ? 1.5 : 2,
          strokeDasharray: toExternal ? "5 3" : dashed ? "4 4" : undefined,
        },
        markerEnd: dashed ? undefined : { type: MarkerType.ArrowClosed, color },
      };
    });

    return { viewNodes: view.nodes, positions, symbolCount, handleDirection, rfEdges };
  }, [
    graph,
    expanded,
    enabledEdgeKinds,
    algorithm,
    direction,
    showExternal,
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
  ]);

  const showMiniMap = base.viewNodes.length <= MINIMAP_NODE_LIMIT;

  // Cheap layer: per-node styling for selection/search. A plain array map — no layout.
  const rfNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    const searching = query.length > 0;
    return base.viewNodes.map<Node>((n) => ({
      id: n.id,
      type: "graph",
      position: base.positions.get(n.id) ?? { x: 0, y: 0 },
      selected: n.id === selectedId,
      data: {
        label: n.label,
        kind: n.kind,
        role: n.role,
        externalKind: n.externalKind,
        symbolCount: base.symbolCount.get(n.id) ?? 0,
        expanded: expanded.has(n.id),
        matched: searching && n.label.toLowerCase().includes(query),
        searching,
        direction: base.handleDirection,
      },
    }));
  }, [base, selectedId, search, expanded]);

  // Re-fit the viewport when the geometry changes (layout/expand/new graph).
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [fitView, algorithm, direction, expanded, graph]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={base.rfEdges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.02}
      maxZoom={2}
      // Virtualize: only mount nodes/edges inside the viewport — essential for large graphs.
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const kind = (node.data as { kind: NodeKind }).kind;
        if (kind === "file") onToggleExpand(node.id);
        onSelect(node.id);
      }}
    >
      <Background gap={22} size={1} color="rgba(148, 163, 184, 0.10)" />
      <Controls showInteractive={false} />
      {showMiniMap && (
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const d = n.data as { kind: NodeKind; role?: NodeRole; externalKind?: ExternalKind };
            return nodeStyle(d.kind, d.role, d.externalKind).color;
          }}
          maskColor="rgba(0,0,0,0.4)"
          style={{ background: "var(--chakra-colors-bg-panel)" }}
        />
      )}
    </ReactFlow>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
