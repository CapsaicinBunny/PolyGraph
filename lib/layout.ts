import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";

export interface XYPosition {
  x: number;
  y: number;
}

/**
 * Minimal layout input — just what the algorithms read. A full GraphView is
 * assignable to this, and it's small enough to post to a Web Worker.
 */
export interface LayoutInput {
  nodes: { id: string; kind: string }[];
  edges: { source: string; target: string }[];
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

/** Convert a layout center point to the top-left position the scene expects. */
function topLeft(node: { id: string; kind: string }, cx: number, cy: number): [string, XYPosition] {
  const size = nodeSize(node.kind);
  return [node.id, { x: cx - size.width / 2, y: cy - size.height / 2 }];
}

function dagreLayout(
  view: LayoutInput,
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

// --- Disconnected-graph handling -------------------------------------------
// Views are typically sparse: many nodes have no edges in the current filter.
// Laying the whole set out at once collapses badly — dagre dumps every isolated
// node onto rank 0 (one ultra-wide row), radial piles them at the center. So we
// split the view into connected components, lay each out independently with the
// chosen algorithm, and shelf-pack the results: connected clusters read clearly
// and singletons tile neatly instead of collapsing into a line/blob.

/** Connected components (edges treated as undirected) via union-find. */
function connectedComponents(view: LayoutInput): string[][] {
  const parent = new Map<string, string>();
  for (const n of view.nodes) parent.set(n.id, n.id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    while (parent.get(x) !== r) {
      const next = parent.get(x) as string;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const e of view.edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue;
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const n of view.nodes) {
    const r = find(n.id);
    const g = groups.get(r);
    if (g) g.push(n.id);
    else groups.set(r, [n.id]);
  }
  return [...groups.values()];
}

interface Box {
  width: number;
  height: number;
}

/** Row-major shelf packing (tallest box first); returns a top-left offset per box. */
function shelfPack(boxes: Box[], gap: number): XYPosition[] {
  const offsets: XYPosition[] = boxes.map(() => ({ x: 0, y: 0 }));
  if (boxes.length === 0) return offsets;
  const totalArea = boxes.reduce((a, b) => a + (b.width + gap) * (b.height + gap), 0);
  const maxWidth = Math.max(...boxes.map((b) => b.width));
  // Roughly square overall, but never narrower than the widest component.
  const rowWidth = Math.max(maxWidth, Math.sqrt(totalArea) * 1.4);
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].height - boxes[a].height);
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const i of order) {
    const b = boxes[i];
    if (x > 0 && x + b.width > rowWidth) {
      x = 0;
      y += shelfH + gap;
      shelfH = 0;
    }
    offsets[i] = { x, y };
    x += b.width + gap;
    shelfH = Math.max(shelfH, b.height);
  }
  return offsets;
}

/** Lay each connected component out with `perComponent`, then shelf-pack them. */
function layoutByComponents(
  view: LayoutInput,
  perComponent: (sub: LayoutInput) => Positions,
): Positions {
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  const comps = connectedComponents(view);

  const laid = comps.map((ids) => {
    let positions: Positions;
    if (ids.length === 1) {
      const node = nodeById.get(ids[0]) as { id: string; kind: string };
      positions = new Map([topLeft(node, 0, 0)]);
    } else {
      const idset = new Set(ids);
      positions = perComponent({
        nodes: ids.map((id) => nodeById.get(id) as { id: string; kind: string }),
        edges: view.edges.filter((e) => idset.has(e.source) && idset.has(e.target)),
      });
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const p = positions.get(id);
      if (!p) continue;
      const { width, height } = nodeSize(nodeById.get(id)?.kind ?? "");
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + width);
      maxY = Math.max(maxY, p.y + height);
    }
    return { ids, positions, minX, minY, width: maxX - minX, height: maxY - minY };
  });

  const offsets = shelfPack(
    laid.map((c) => ({ width: c.width, height: c.height })),
    60,
  );

  const out: Positions = new Map();
  laid.forEach((c, i) => {
    const dx = offsets[i].x - c.minX;
    const dy = offsets[i].y - c.minY;
    for (const id of c.ids) {
      const p = c.positions.get(id);
      if (p) out.set(id, { x: p.x + dx, y: p.y + dy });
    }
  });
  return out;
}

/** Concentric rings by graph distance from root (in-degree 0) nodes, for one component. */
function radialLayout(view: LayoutInput): Positions {
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

/** A component's nodes evenly spaced on a single circle. */
function circularLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  if (n === 1) {
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  // Radius from a fixed per-node arc length so nodes never crowd on the ring.
  const radius = Math.max(160, (n * 80) / (2 * Math.PI));
  view.nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
  });
  return positions;
}

/** Simple row-major grid. */
function gridLayout(view: LayoutInput): Positions {
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
function forceLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  if (view.nodes.length === 0) return positions;

  const simNodes: SimNode[] = view.nodes.map((n) => ({ id: n.id }));
  const ids = new Set(simNodes.map((n) => n.id));
  const links = view.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-1200).distanceMax(2200))
    .force(
      "link",
      forceLink<SimNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .distance(220)
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(110))
    .stop();

  // Run to convergence synchronously (no animation), deterministic given the input.
  for (let i = 0; i < 400; i++) sim.tick();

  view.nodes.forEach((node, i) => {
    const sn = simNodes[i];
    positions.set(...topLeft(node, sn.x ?? 0, sn.y ?? 0));
  });
  return positions;
}

// Small LRU of computed layouts, so toggling filters/algorithms back to a prior
// state (or any re-render) reuses positions instead of re-running dagre/force.
const LAYOUT_CACHE_MAX = 24;
const layoutCache = new Map<string, Positions>();

/** Look up a previously computed layout by signature (LRU refresh). */
export function layoutCacheGet(signature: string): Positions | undefined {
  const cached = layoutCache.get(signature);
  if (cached) {
    layoutCache.delete(signature);
    layoutCache.set(signature, cached);
  }
  return cached;
}

/** Store a computed layout, evicting the oldest entry past the cap. */
export function layoutCacheSet(signature: string, positions: Positions): void {
  layoutCache.set(signature, positions);
  if (layoutCache.size > LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
}

/** layoutView, memoized by an externally supplied signature that uniquely identifies the view. */
export function layoutViewCached(
  signature: string,
  view: LayoutInput,
  options: LayoutOptions = {},
): Positions {
  const cached = layoutCacheGet(signature);
  if (cached) return cached;
  const positions = layoutView(view, options);
  layoutCacheSet(signature, positions);
  return positions;
}

/**
 * Compute node positions for a view using the chosen algorithm. Returns top-left
 * positions keyed by node id. Deterministic for a given input.
 */
export function layoutView(view: LayoutInput, options: LayoutOptions = {}): Positions {
  const { algorithm = "layered", direction = "LR" } = options;
  switch (algorithm) {
    case "tree":
      return layoutByComponents(view, (sub) => dagreLayout(sub, direction, "tight-tree"));
    case "radial":
      return layoutByComponents(view, radialLayout);
    case "circular":
      return layoutByComponents(view, circularLayout);
    case "grid":
      return gridLayout(view);
    case "force":
      return forceLayout(view);
    default:
      return layoutByComponents(view, (sub) => dagreLayout(sub, direction, "network-simplex"));
  }
}
