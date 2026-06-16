import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
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

/** Flow direction for the directional (layered / tree) algorithms — mirrors Mermaid. */
export type LayoutDirection = "LR" | "TB" | "RL" | "BT";

/** Available layout algorithms. */
export type LayoutAlgorithm = "layered" | "tree" | "radial" | "circular" | "grid" | "force";

/** Algorithms for which the direction selector is meaningful. */
export const DIRECTIONAL_ALGORITHMS: LayoutAlgorithm[] = ["layered", "tree"];

export interface LayoutOptions {
  algorithm?: LayoutAlgorithm;
  direction?: LayoutDirection;
}

type Positions = Map<string, XYPosition>;

/** Convert a center point to React Flow's top-left convention for a node. */
function topLeft(node: { id: string; kind: string }, cx: number, cy: number): [string, XYPosition] {
  const size = nodeSize(node.kind);
  return [node.id, { x: cx - size.width / 2, y: cy - size.height / 2 }];
}

function dagreLayout(
  view: GraphView,
  direction: LayoutDirection,
  ranker: "network-simplex" | "tight-tree" | "longest-path",
): Positions {
  const vertical = direction === "TB" || direction === "BT";
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    ranker,
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
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions: Positions = new Map();
  for (const node of view.nodes) {
    const laid = g.node(node.id);
    positions.set(...topLeft(node, laid?.x ?? 0, laid?.y ?? 0));
  }
  return positions;
}

/** Concentric rings by graph distance from root (in-degree 0) nodes. */
function radialLayout(view: GraphView): Positions {
  const positions: Positions = new Map();
  if (view.nodes.length === 0) return positions;

  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of view.nodes) {
    adj.set(n.id, new Set());
    indeg.set(n.id, 0);
  }
  for (const e of view.edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  const depth = new Map<string, number>();
  const roots = view.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const queue = roots.length > 0 ? [...roots] : [view.nodes[0].id];
  for (const r of queue) depth.set(r, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const d = depth.get(id) ?? 0;
    for (const nb of adj.get(id) ?? []) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  // Disconnected nodes land on an extra outer ring.
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of view.nodes) if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);

  const byDepth = new Map<number, string[]>();
  for (const n of view.nodes) {
    const d = depth.get(n.id) ?? 0;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d))?.push(n.id);
  }

  const RING = 260;
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  for (const [d, ids] of byDepth) {
    const radius = d === 0 ? (ids.length > 1 ? RING * 0.5 : 0) : d * RING;
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2;
      const node = nodeById.get(id);
      if (node) positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
    });
  }
  return positions;
}

/** All nodes evenly spaced on a single circle. */
function circularLayout(view: GraphView): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  const radius = Math.max(220, (n * 90) / (2 * Math.PI));
  view.nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
  });
  return positions;
}

/** Simple row-major grid. */
function gridLayout(view: GraphView): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = 250;
  const cellH = 110;
  view.nodes.forEach((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(...topLeft(node, col * cellW, row * cellH));
  });
  return positions;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Force-directed layout via a fixed number of synchronous d3-force ticks. */
function forceLayout(view: GraphView): Positions {
  const positions: Positions = new Map();
  if (view.nodes.length === 0) return positions;

  const simNodes: SimNode[] = view.nodes.map((n) => ({ id: n.id }));
  const ids = new Set(simNodes.map((n) => n.id));
  const links = view.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-500))
    .force(
      "link",
      forceLink<SimNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .distance(150)
        .strength(0.5),
    )
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(70))
    .stop();

  // Run to convergence synchronously (no animation), deterministic given the input.
  for (let i = 0; i < 320; i++) sim.tick();

  view.nodes.forEach((node, i) => {
    const sn = simNodes[i];
    positions.set(...topLeft(node, sn.x ?? 0, sn.y ?? 0));
  });
  return positions;
}

/**
 * Compute node positions for a view using the chosen algorithm. Returns top-left
 * positions (React Flow's convention) keyed by node id. Deterministic for a given input.
 */
export function layoutView(view: GraphView, options: LayoutOptions = {}): Positions {
  const { algorithm = "layered", direction = "LR" } = options;
  switch (algorithm) {
    case "tree":
      return dagreLayout(view, direction, "tight-tree");
    case "radial":
      return radialLayout(view);
    case "circular":
      return circularLayout(view);
    case "grid":
      return gridLayout(view);
    case "force":
      return forceLayout(view);
    default:
      return dagreLayout(view, direction, "network-simplex");
  }
}
