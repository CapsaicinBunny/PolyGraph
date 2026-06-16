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
  layoutView,
} from "@/lib/layout";
import { GraphFlowNode } from "./nodes/GraphFlowNode";

const nodeTypes = { graph: GraphFlowNode };

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

  const { rfNodes, rfEdges } = useMemo(() => {
    // Apply node filters. Environment/runtime apply to every node (so you can isolate,
    // e.g., only client-side files); kind/category apply to symbols. Externals follow
    // their toggle. Edges with a hidden endpoint drop out.
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
    const positions = layoutView(
      { nodes: view.nodes, edges: visibleEdges },
      { algorithm, direction },
    );
    // Handle anchors only track direction for the directional algorithms.
    const handleDirection = DIRECTIONAL_ALGORITHMS.includes(algorithm) ? direction : "LR";
    const query = search.trim().toLowerCase();
    const searching = query.length > 0;
    const symbolCount = new Map<string, number>();
    for (const n of graph.nodes) {
      if (n.kind !== "file")
        symbolCount.set(n.parentFile, (symbolCount.get(n.parentFile) ?? 0) + 1);
    }

    const rfNodes: Node[] = view.nodes.map((n) => ({
      id: n.id,
      type: "graph",
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      selected: n.id === selectedId,
      data: {
        label: n.label,
        kind: n.kind,
        role: n.role,
        externalKind: n.externalKind,
        symbolCount: symbolCount.get(n.id) ?? 0,
        expanded: expanded.has(n.id),
        matched: searching && n.label.toLowerCase().includes(query),
        searching,
        direction: handleDirection,
      },
    }));

    // Edges that point at an external node take that node's family color so they
    // read as a distinct group from internal edges.
    const externalColor = new Map<string, string>();
    for (const n of view.nodes) {
      if (n.kind === "external")
        externalColor.set(n.id, nodeStyle(n.kind, n.role, n.externalKind).color);
    }

    const rfEdges: Edge[] = visibleEdges.map((e) => {
      const style = EDGE_STYLES[e.kind as ViewEdgeKind];
      const dashed = e.kind === "contains";
      const toExternal = externalColor.get(e.target);
      const color = toExternal ?? style.color;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        // Animate every relationship edge (flows source -> target); skip structural containment.
        animated: e.kind !== "contains",
        style: {
          stroke: color,
          strokeWidth: dashed ? 1.5 : 2,
          strokeDasharray: toExternal ? "5 3" : dashed ? "4 4" : undefined,
        },
        markerEnd: dashed ? undefined : { type: MarkerType.ArrowClosed, color },
      };
    });

    return { rfNodes, rfEdges };
  }, [
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
  ]);

  // Re-fit the viewport after the layout changes (direction switch, expand/collapse,
  // or a freshly loaded graph). rAF lets React Flow measure the new node positions first.
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [fitView, algorithm, direction, expanded, graph]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.05}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const kind = (node.data as { kind: NodeKind }).kind;
        if (kind === "file") onToggleExpand(node.id);
        onSelect(node.id);
      }}
    >
      <Background gap={22} size={1} color="rgba(148, 163, 184, 0.10)" />
      <Controls showInteractive={false} />
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
