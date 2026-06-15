import dagre from "@dagrejs/dagre";
import type { GraphView } from "./aggregate";

export interface XYPosition {
  x: number;
  y: number;
}

export interface NodeSize {
  width: number;
  height: number;
}

export const FILE_SIZE: NodeSize = { width: 200, height: 56 };
export const SYMBOL_SIZE: NodeSize = { width: 170, height: 44 };

export function nodeSize(kind: string): NodeSize {
  return kind === "file" ? FILE_SIZE : SYMBOL_SIZE;
}

/**
 * Compute left-to-right dagre positions for a view. Returns top-left positions
 * (React Flow's coordinate convention) keyed by node id. Deterministic for a
 * given input.
 */
export function layoutView(view: GraphView): Map<string, XYPosition> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of view.nodes) {
    g.setNode(node.id, nodeSize(node.kind));
  }
  for (const edge of view.edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const positions = new Map<string, XYPosition>();
  for (const node of view.nodes) {
    const laid = g.node(node.id);
    const size = nodeSize(node.kind);
    positions.set(node.id, {
      x: (laid?.x ?? 0) - size.width / 2,
      y: (laid?.y ?? 0) - size.height / 2,
    });
  }
  return positions;
}
