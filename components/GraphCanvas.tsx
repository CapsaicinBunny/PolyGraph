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
import type { ViewEdgeKind } from "@/lib/aggregate";
import type { SceneFilters } from "@/lib/graph/scene";
import type {
  Environment,
  ExternalKind,
  GraphModel,
  NodeCategory,
  NodeKind,
  NodeRole,
  Runtime,
} from "@/lib/graph/types";
import { nodeStyle } from "@/lib/graph/visual";
import { DIRECTIONAL_ALGORITHMS, type LayoutAlgorithm, type LayoutDirection } from "@/lib/layout";
import { LayoutOverlay } from "./LayoutOverlay";
import { GraphFlowNode } from "./nodes/GraphFlowNode";
import { useScene } from "./useScene";

const nodeTypes = { graph: GraphFlowNode };

const ANIMATE_EDGE_LIMIT = 250;
const MINIMAP_NODE_LIMIT = 600;

export interface GraphCanvasProps {
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

  const rfEdges = useMemo(() => {
    const animate = scene.edges.length <= ANIMATE_EDGE_LIMIT;
    return scene.edges.map<Edge>((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: animate && e.kind !== "contains",
      style: {
        stroke: e.color,
        strokeWidth: e.dashed ? 1.5 : 2,
        strokeDasharray: e.toExternal ? "5 3" : e.dashed ? "4 4" : undefined,
      },
      markerEnd: e.dashed ? undefined : { type: MarkerType.ArrowClosed, color: e.color },
    }));
  }, [scene]);

  const handleDirection = DIRECTIONAL_ALGORITHMS.includes(algorithm) ? direction : "LR";

  const rfNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    const searching = query.length > 0;
    return scene.nodes.map<Node>((n) => ({
      id: n.id,
      type: "graph",
      position: { x: n.x, y: n.y },
      selected: n.id === selectedId,
      data: {
        label: n.label,
        kind: n.kind,
        role: n.role,
        externalKind: n.externalKind,
        symbolCount: n.symbolCount,
        expanded: expanded.has(n.id),
        matched: searching && n.label.toLowerCase().includes(query),
        searching,
        direction: handleDirection,
      },
    }));
  }, [scene, selectedId, search, expanded, handleDirection]);

  const showMiniMap = scene.nodes.length <= MINIMAP_NODE_LIMIT;

  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    return () => cancelAnimationFrame(id);
  }, [fitView, scene]);

  return (
    <>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.02}
        maxZoom={2}
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
      {layingOut && <LayoutOverlay />}
    </>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
