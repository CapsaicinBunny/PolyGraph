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
import type { GraphModel, NodeKind } from "@/lib/graph/types";
import { EDGE_STYLES, NODE_STYLES } from "@/lib/graph/visual";
import { type LayoutDirection, layoutView } from "@/lib/layout";
import { GraphFlowNode } from "./nodes/GraphFlowNode";

const nodeTypes = { graph: GraphFlowNode };

interface GraphCanvasProps {
  graph: GraphModel;
  expanded: Set<string>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  search: string;
  selectedId: string | null;
  direction: LayoutDirection;
  onSelect: (id: string) => void;
  onToggleExpand: (fileId: string) => void;
}

function GraphCanvasInner({
  graph,
  expanded,
  enabledEdgeKinds,
  search,
  selectedId,
  direction,
  onSelect,
  onToggleExpand,
}: GraphCanvasProps) {
  const { fitView } = useReactFlow();

  const { rfNodes, rfEdges } = useMemo(() => {
    const view = buildView(graph, expanded);
    const visibleEdges = view.edges.filter(
      (e) => e.kind === "contains" || enabledEdgeKinds.has(e.kind),
    );
    const positions = layoutView({ nodes: view.nodes, edges: visibleEdges }, { direction });
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
        symbolCount: symbolCount.get(n.id) ?? 0,
        expanded: expanded.has(n.id),
        matched: searching && n.label.toLowerCase().includes(query),
        searching,
        direction,
      },
    }));

    const rfEdges: Edge[] = visibleEdges.map((e) => {
      const style = EDGE_STYLES[e.kind as ViewEdgeKind];
      const dashed = e.kind === "contains";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === "call",
        style: {
          stroke: style.color,
          strokeWidth: 1.5,
          strokeDasharray: dashed ? "4 4" : undefined,
        },
        markerEnd: dashed ? undefined : { type: MarkerType.ArrowClosed, color: style.color },
      };
    });

    return { rfNodes, rfEdges };
  }, [graph, expanded, enabledEdgeKinds, search, selectedId, direction]);

  // Re-fit the viewport after the layout changes (direction switch, expand/collapse,
  // or a freshly loaded graph). rAF lets React Flow measure the new node positions first.
  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [fitView, direction, expanded, graph]);

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
      <Background gap={20} color="var(--chakra-colors-border-muted)" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => NODE_STYLES[(n.data as { kind: NodeKind }).kind].color}
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
