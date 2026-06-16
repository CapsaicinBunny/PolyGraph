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

/** Flow direction, mirroring Mermaid's graph directions. */
export type LayoutDirection = "LR" | "TB" | "RL" | "BT";

/** Ranking algorithm — changes how "tree-like" vs. balanced the layout looks. */
export type LayoutRanker = "network-simplex" | "tight-tree" | "longest-path";

export interface LayoutOptions {
  direction?: LayoutDirection;
  ranker?: LayoutRanker;
}

/**
 * Compute dagre positions for a view in the requested direction. Returns
 * top-left positions (React Flow's coordinate convention) keyed by node id.
 * Deterministic for a given input.
 */
export function layoutView(view: GraphView, options: LayoutOptions = {}): Map<string, XYPosition> {
  const { direction = "LR", ranker = "network-simplex" } = options;
  const vertical = direction === "TB" || direction === "BT";

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    ranker,
    // Give vertical layouts a bit more rank spacing so labels don't collide.
    nodesep: vertical ? 36 : 24,
    ranksep: vertical ? 70 : 90,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of view.nodes) {
    // Fresh object per node: dagre writes x/y onto the value object, so a shared
    // reference would collapse every node to the same position.
    const { width, height } = nodeSize(node.kind);
    g.setNode(node.id, { width, height });
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
