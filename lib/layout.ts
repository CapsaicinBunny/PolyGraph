import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import { stratify, tree as d3tree } from "d3-hierarchy";
import { Layout as ColaLayout } from "webcola";
import type { ViewEdgeKind } from "./aggregate";
import { coreness } from "./layout/backbone";
import { fiedlerOrder, orderByBarycenter, stableOrder } from "./layout/ordering";
import { chooseEngine } from "./layout/planner";
import { graphShape } from "./layout/shape";
import { smartLayout } from "./layout/smart";
import { buildArborescence } from "./layout/tree";

export interface XYPosition {
  x: number;
  y: number;
}

/**
 * Minimal layout input — just what the algorithms read. A full GraphView is
 * assignable to this, and it's small enough to post to a Web Worker. Edges carry
 * the relationship `kind`/`count` and a precomputed `weight` (see lib/layout/weight.ts)
 * so weighted engines (layered, ordering) can rank architectural edges above
 * incidental ones; all three are optional so unweighted callers/tests still apply.
 */
export interface LayoutInput {
  nodes: { id: string; kind: string }[];
  edges: { source: string; target: string; kind?: ViewEdgeKind; count?: number; weight?: number }[];
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
export type LayoutAlgorithm =
  | "smart"
  | "layered"
  | "tree"
  | "radial"
  | "circular"
  | "grid"
  | "force"
  | "stress"
  | "backbone";

/** Algorithms for which the direction selector is meaningful. */
export const DIRECTIONAL_ALGORITHMS: LayoutAlgorithm[] = ["smart", "layered", "tree"];

/** How the Smart layout groups nodes into clusters. */
export type GroupBy = "directory" | "community" | "none";

export interface LayoutOptions {
  algorithm?: LayoutAlgorithm;
  direction?: LayoutDirection;
  groupBy?: GroupBy;
  /** Spacing multiplier for the Smart layout (1 = normal; >1 sparser, <1 denser). */
  density?: number;
  /**
   * Precomputed community assignment (nodeId → community id). Injected so the
   * Smart layout and the collapse transform share a single source of truth.
   */
  communityOf?: Map<string, string>;
  /**
   * Previous top-left positions, keyed by node id. Engines seed from these so a
   * re-layout after a filter/zoom change preserves the mental map instead of
   * reshuffling. Nodes without a prior position fall back to the engine default.
   */
  previousPositions?: Map<string, XYPosition>;
}

/** Why the budget guard downgraded a leaf cluster's planner choice to grid (null = it didn't). */
export type FallbackReason = "node-cap" | "edge-cap" | null;

/** A directory/package container box emitted by the Smart layout. World-space, top-left origin. */
export interface ClusterBox {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  label: string;
  /**
   * For a leaf cluster laid out by the Smart planner: the engine actually run inside it,
   * what the planner asked for before the budget guard, and why it was downgraded (if so).
   * Undefined for container boxes, whose children are arranged by the item-box placement.
   * Diagnostics only (feeds the future "layout simplified" indicator); LOD ignores these.
   */
  engine?: LayoutAlgorithm;
  requestedEngine?: LayoutAlgorithm;
  fallbackReason?: FallbackReason;
}

/** Smart layout output: node positions plus the nested container boxes. */
export interface LayoutResult {
  nodes: Map<string, XYPosition>;
  clusters: ClusterBox[];
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
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      // Weight ranking + crossing reduction by the relationship's importance, so a
      // single `extends` outranks many incidental `call`s. Falls back to 1 (dagre's
      // default) for unweighted callers and structural ("contains") edges.
      const w = edge.weight ?? 1;
      g.setEdge(edge.source, edge.target, { weight: w > 0 ? w : 1 });
    }
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

/**
 * Row-major shelf packing in the GIVEN order (callers pre-sort by a stable key so
 * the arrangement doesn't reshuffle when a component's size changes); returns a
 * top-left offset per box.
 */
function shelfPack(boxes: Box[], gap: number): XYPosition[] {
  const offsets: XYPosition[] = boxes.map(() => ({ x: 0, y: 0 }));
  if (boxes.length === 0) return offsets;
  const totalArea = boxes.reduce((a, b) => a + (b.width + gap) * (b.height + gap), 0);
  let maxWidth = 0;
  for (const b of boxes) if (b.width > maxWidth) maxWidth = b.width;
  // Roughly square overall, but never narrower than the widest component.
  const rowWidth = Math.max(maxWidth, Math.sqrt(totalArea) * 1.4);
  const order = boxes.map((_, i) => i);
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

  // Pack components in a stable id order (min member id), so adding/removing nodes
  // elsewhere doesn't reshuffle where each component lands — preserving the mental map.
  laid.sort((p, q) => {
    const pm = p.ids.reduce((m, x) => (x < m ? x : m), p.ids[0]);
    const qm = q.ids.reduce((m, x) => (x < m ? x : m), q.ids[0]);
    return pm < qm ? -1 : pm > qm ? 1 : 0;
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

/**
 * Concentric rings by directed dependency depth from source (in-degree-0) roots.
 * Rings are ordered inner→outer; each ring's angular order is the barycenter of its
 * nodes' inner-ring neighbors (crossing reduction), seeded by the stable tie-break —
 * so subtrees stay angularly grouped and the result is input-order-independent.
 */
function radialLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  if (view.nodes.length === 0) return positions;

  // Directed outgoing edges drive ring depth (dependency flow); the undirected view
  // drives angular barycenter (a node's neighbors on the adjacent inner ring).
  const out = new Map<string, string[]>();
  const undir = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const nd of view.nodes) {
    out.set(nd.id, []);
    undir.set(nd.id, new Set());
    indeg.set(nd.id, 0);
  }
  for (const e of view.edges) {
    if (!out.has(e.source) || !out.has(e.target)) continue;
    out.get(e.source)!.push(e.target);
    undir.get(e.source)!.add(e.target);
    undir.get(e.target)!.add(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  // Roots = sources (in-degree 0). If the component is fully cyclic, fall back to the
  // highest-out-degree node (most reach), broken deterministically by the stable order.
  const ids = view.nodes.map((nd) => nd.id);
  let roots = stableOrder(
    view.nodes.filter((nd) => (indeg.get(nd.id) ?? 0) === 0).map((nd) => nd.id),
  );
  if (roots.length === 0) {
    roots = [
      stableOrder(ids).reduce((best, id) =>
        out.get(id)!.length > out.get(best)!.length ? id : best,
      ),
    ];
  }

  // Directed BFS depth from the roots over outgoing edges.
  const depth = new Map<string, number>();
  const queue = [...roots];
  for (const r of roots) depth.set(r, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const d = depth.get(id)!;
    for (const nb of out.get(id) ?? []) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  // Nodes not reachable via outgoing edges (other cycle members, sinks) → outer ring.
  let maxDepth = 0;
  for (const d of depth.values()) if (d > maxDepth) maxDepth = d;
  for (const nd of view.nodes) if (!depth.has(nd.id)) depth.set(nd.id, maxDepth + 1);

  const byDepth = new Map<number, string[]>();
  for (const nd of view.nodes) {
    const d = depth.get(nd.id) ?? 0;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d))?.push(nd.id);
  }

  // Arc allowance per node (≈ widest card + breathing room) and the minimum radial
  // gap between consecutive rings. A ring's radius is the larger of "big enough to fit
  // all its nodes around the circumference" and "clear of the inner ring", so a crowded
  // ring grows outward instead of cramming its nodes into an overlapping circle.
  const ARC = 220;
  const RING_GAP = 220;
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  let prevRing: string[] = [];
  let prevRadius = 0;
  let first = true;
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ringIds = byDepth.get(d)!;
    // Inner ring first; subsequent rings ordered by barycenter of inner-ring neighbors.
    const ordered =
      prevRing.length === 0
        ? stableOrder(ringIds)
        : (() => {
            const prevPos = new Map(prevRing.map((id, i) => [id, i]));
            return orderByBarycenter(stableOrder(ringIds), (id) => {
              const ns: { pos: number; weight: number }[] = [];
              for (const nb of undir.get(id) ?? []) {
                const p = prevPos.get(nb);
                if (p !== undefined) ns.push({ pos: p, weight: 1 });
              }
              return ns;
            });
          })();
    const fitRadius = (ordered.length * ARC) / (2 * Math.PI);
    let radius: number;
    if (first) radius = ordered.length > 1 ? fitRadius : 0;
    else radius = Math.max(prevRadius + RING_GAP, fitRadius);
    ordered.forEach((id, i) => {
      const node = nodeById.get(id);
      if (!node) return;
      const angle = (i / ordered.length) * Math.PI * 2;
      positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
    });
    prevRing = ordered;
    prevRadius = radius;
    first = false;
  }
  return positions;
}

/** A component's nodes on a single circle, ordered by the Fiedler vector. */
function circularLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  if (n === 1) {
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  // Order the ring spectrally so graph-adjacent nodes land at adjacent angles (few
  // chord crossings), rather than placing nodes in arbitrary input order.
  const order = fiedlerOrder(
    view.nodes.map((nd) => nd.id),
    view.edges,
  );
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  // Radius from a fixed per-node arc length so nodes never crowd on the ring.
  const radius = Math.max(160, (n * 80) / (2 * Math.PI));
  order.forEach((id, i) => {
    const node = nodeById.get(id);
    if (!node) return;
    const angle = (i / n) * Math.PI * 2;
    positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
  });
  return positions;
}

/** Row-major grid, filled in directory-grouped (stable) order rather than input order. */
function gridLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  // Group same-directory nodes together (and order isolates by dir→path) so the grid
  // reads as a tidy, locality-preserving table instead of arbitrary input order.
  const order = stableOrder(view.nodes.map((nd) => nd.id));
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = 250;
  const cellH = 110;
  order.forEach((id, i) => {
    const node = nodeById.get(id);
    if (!node) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(...topLeft(node, col * cellW, row * cellH));
  });
  return positions;
}

interface StratifyDatum {
  id: string;
  parentId: string | null;
}

/**
 * Tidy tree: extract a spanning arborescence (strongest-parent), then place it with
 * d3-hierarchy's Buchheim/Walker tidy-tree (linear, deterministic, compact). The
 * tree axis follows `direction`; non-tree edges are drawn as secondary cross-links.
 */
function treeLayout(view: LayoutInput, direction: LayoutDirection): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  if (n === 1) {
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  const { parent } = buildArborescence(
    view.nodes.map((nd) => nd.id),
    view.edges,
  );
  // A single virtual root unifies a forest into one hierarchy for stratify.
  const VIRTUAL = " treeRoot";
  const data: StratifyDatum[] = view.nodes.map((nd) => ({
    id: nd.id,
    parentId: parent.get(nd.id) ?? VIRTUAL,
  }));
  data.push({ id: VIRTUAL, parentId: null });
  // d3.stratify orders each parent's children by their order in `data`, so sort by id
  // to make sibling placement independent of input order (deterministic).
  data.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let root: ReturnType<ReturnType<typeof d3tree<StratifyDatum>>>;
  try {
    const h = stratify<StratifyDatum>()
      .id((d) => d.id)
      .parentId((d) => d.parentId)(data);
    const vertical = direction === "TB" || direction === "BT";
    const sample = nodeSize("file");
    const dx = (vertical ? sample.width : sample.height) + 40;
    const dy = (vertical ? sample.height : sample.width) + 80;
    root = d3tree<StratifyDatum>().nodeSize([dx, dy])(h);
  } catch {
    return gridLayout(view); // defensive: stratify only throws on a malformed forest
  }

  root.each((dnode) => {
    if (dnode.data.id === VIRTUAL) return;
    const node = nodeById.get(dnode.data.id);
    if (!node) return;
    const across = dnode.x; // cross-axis (siblings)
    const depth = dnode.y; // depth-axis (levels)
    let cx: number;
    let cy: number;
    switch (direction) {
      case "BT":
        cx = across;
        cy = -depth;
        break;
      case "LR":
        cx = depth;
        cy = across;
        break;
      case "RL":
        cx = -depth;
        cy = across;
        break;
      default:
        cx = across;
        cy = depth;
    }
    positions.set(...topLeft(node, cx, cy));
  });
  return positions;
}

/**
 * Backbone (core-periphery): lay out the dense 2+-core with force, then hang the
 * low-coreness periphery (leaves/chains) off it in golden-angle fans via a BFS
 * outward from the core — so thousands of leaves don't blow the core apart. Falls
 * back to a tidy tree when there's no real core (everything is 1-core).
 */
function backboneLayout(view: LayoutInput): Positions {
  const ids = view.nodes.map((n) => n.id);
  const core = coreness(ids, view.edges);
  let maxCore = 0;
  for (const c of core.values()) if (c > maxCore) maxCore = c;
  if (maxCore < 2) return treeLayout(view, "TB");

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  const coreSet = new Set(ids.filter((id) => (core.get(id) ?? 0) >= 2));
  const positions = forceLayout({
    nodes: view.nodes.filter((n) => coreSet.has(n.id)),
    edges: view.edges.filter((e) => coreSet.has(e.source) && coreSet.has(e.target)),
  });

  const undirected = new Map<string, Set<string>>();
  for (const id of ids) undirected.set(id, new Set());
  for (const e of view.edges) {
    if (e.source === e.target || !undirected.has(e.source) || !undirected.has(e.target)) continue;
    undirected.get(e.source)!.add(e.target);
    undirected.get(e.target)!.add(e.source);
  }

  const centerOf = (id: string): XYPosition => {
    const p = positions.get(id) ?? { x: 0, y: 0 };
    const s = nodeSize(nodeById.get(id)?.kind ?? "");
    return { x: p.x + s.width / 2, y: p.y + s.height / 2 };
  };
  const placed = new Set(coreSet);
  const fan = new Map<string, number>();
  const SAT_SPACING = 130; // phyllotaxis spacing → nearest satellites ≈ a card apart
  const frontier = () =>
    ids
      .filter(
        (id) => !placed.has(id) && [...(undirected.get(id) ?? [])].some((nb) => placed.has(nb)),
      )
      .sort(cmp);
  for (let wave = frontier(); wave.length > 0; wave = frontier()) {
    for (const id of wave) {
      if (placed.has(id)) continue;
      const anchor = [...(undirected.get(id) ?? [])].filter((nb) => placed.has(nb)).sort(cmp)[0];
      const node = nodeById.get(id);
      if (!anchor || !node) continue;
      const c = centerOf(anchor);
      const k = fan.get(anchor) ?? 0;
      fan.set(anchor, k + 1);
      // Sunflower (phyllotaxis): radius grows with the satellite index, so a hub with
      // many leaves fans them into a disk instead of crowding one fixed-radius ring.
      const angle = (k + 1) * 2.39996; // golden angle
      const r = SAT_SPACING * Math.sqrt(k + 1);
      positions.set(...topLeft(node, c.x + Math.cos(angle) * r, c.y + Math.sin(angle) * r));
      placed.add(id);
    }
  }
  // Anything detached from the core: tuck it into a grid well below.
  const leftover = ids.filter((id) => !placed.has(id)).sort(cmp);
  const cols = Math.max(1, Math.ceil(Math.sqrt(leftover.length)));
  leftover.forEach((id, i) => {
    const node = nodeById.get(id);
    if (node) positions.set(...topLeft(node, (i % cols) * 250, 4000 + Math.floor(i / cols) * 110));
  });
  return positions;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Force-directed layout via a fixed number of synchronous d3-force ticks. */
function forceLayout(view: LayoutInput, options: LayoutOptions = {}): Positions {
  const positions: Positions = new Map();
  if (view.nodes.length === 0) return positions;

  // Seed from previous positions (top-left → center) so the simulation continues
  // from the prior layout rather than the default index arrangement — preserving
  // the mental map. Unseeded nodes get d3's deterministic default placement.
  const prev = options.previousPositions;
  const simNodes: SimNode[] = view.nodes.map((n) => {
    const p = prev?.get(n.id);
    if (!p) return { id: n.id };
    const size = nodeSize(n.kind);
    return { id: n.id, x: p.x + size.width / 2, y: p.y + size.height / 2 };
  });
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
    .force("collide", forceCollide(130))
    .stop();

  // Run to convergence synchronously (no animation), deterministic given the input.
  for (let i = 0; i < 400; i++) sim.tick();

  view.nodes.forEach((node, i) => {
    const sn = simNodes[i];
    positions.set(...topLeft(node, sn.x ?? 0, sn.y ?? 0));
  });
  return positions;
}

/**
 * Stress-majorization layout (cola.js): places nodes so Euclidean distance tracks
 * graph-theoretic distance, with non-overlap constraints. Deterministic — cola uses
 * a seeded PRNG and we seed initial positions (previous layout, else a ring) and run
 * a fixed number of synchronous iterations (keepRunning = false). The best
 * general-purpose engine for irregular, mixed directed/cyclic graphs.
 */
function stressLayout(view: LayoutInput, options: LayoutOptions = {}): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  if (n === 1) {
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  const index = new Map(view.nodes.map((nd, i) => [nd.id, i]));
  const spread = 200 * Math.sqrt(n);
  const colaNodes = view.nodes.map((nd, i) => {
    const s = nodeSize(nd.kind);
    const prev = options.previousPositions?.get(nd.id);
    const angle = (i / n) * Math.PI * 2;
    return {
      x: prev ? prev.x + s.width / 2 : Math.cos(angle) * spread,
      y: prev ? prev.y + s.height / 2 : Math.sin(angle) * spread,
      width: s.width + 24,
      height: s.height + 24,
    };
  });
  const links = view.edges
    .filter((e) => e.source !== e.target && index.has(e.source) && index.has(e.target))
    .map((e) => ({ source: index.get(e.source)!, target: index.get(e.target)! }));
  // The per-component cap (HEAVY_COMPONENT_CAP.stress) bounds n, so overlap avoidance
  // stays ON at a fixed iteration count — cards never sit on top of each other, and the
  // run stays well under the worker timeout. Deterministic (seeded + fixed iterations).
  new ColaLayout()
    .nodes(colaNodes)
    .links(links)
    .avoidOverlaps(true)
    .linkDistance(200)
    .start(30, 20, 40, 0, false, false);
  view.nodes.forEach((nd, i) => {
    positions.set(...topLeft(nd, colaNodes[i].x ?? 0, colaNodes[i].y ?? 0));
  });
  return positions;
}

// Small LRU of computed layouts, so toggling filters/algorithms back to a prior
// state (or any re-render) reuses positions + cluster boxes instead of recomputing.
export interface LayoutCacheEntry {
  positions: Positions;
  clusters: ClusterBox[];
}

const LAYOUT_CACHE_MAX = 24;
const layoutCache = new Map<string, LayoutCacheEntry>();

/** Look up a previously computed layout by signature (LRU refresh). */
export function layoutCacheGet(signature: string): LayoutCacheEntry | undefined {
  const cached = layoutCache.get(signature);
  if (cached) {
    layoutCache.delete(signature);
    layoutCache.set(signature, cached);
  }
  return cached;
}

/** Store a computed layout, evicting the oldest entry past the cap. */
export function layoutCacheSet(signature: string, entry: LayoutCacheEntry): void {
  layoutCache.set(signature, entry);
  if (layoutCache.size > LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
}

/**
 * Compute node positions for a view using the chosen algorithm. Returns top-left
 * positions keyed by node id. Deterministic for a given input.
 */
/** Options forwarded to the clustered (smartLayout) path. */
function smartOptions(options: LayoutOptions) {
  return {
    direction: options.direction,
    groupBy: options.groupBy,
    density: options.density,
    communityOf: options.communityOf,
  };
}

/**
 * Central layout router (used by the worker and the sync fallback). "smart" is the
 * grouping/clustering mode: it clusters by directory/community, or — when "none" —
 * resolves to the planner's shape→engine choice run flat. Every OTHER algorithm runs
 * its own real engine flat, so each layout button is visibly distinct (grouping is a
 * Smart-mode feature; classic engines don't nest). Returns positions + cluster boxes.
 */
export function runLayout(input: LayoutInput, options: LayoutOptions = {}): LayoutResult {
  const algorithm = options.algorithm ?? "layered";
  if (algorithm === "smart") {
    // Smart clusters by directory unless explicitly told "none" (containers off).
    if ((options.groupBy ?? "directory") !== "none")
      return smartLayout(input, smartOptions(options));
    // "none" = no containers, but still pick the engine that fits the graph's shape.
    const engine = chooseEngine(
      graphShape(
        input.nodes.map((n) => n.id),
        input.edges,
      ),
    );
    return { nodes: layoutView(input, { ...options, algorithm: engine }), clusters: [] };
  }
  return { nodes: layoutView(input, options), clusters: [] };
}

// Per-connected-component caps for the heavy engines. The adaptive LOD cut only bounds
// the Smart+Directory path; for EVERY explicitly-selected engine these caps (plus
// guardOptions) are the only protection. Above a cap a component is laid out with the
// cheap deterministic grid, so no engine can blow the 8s worker timeout or pin a core —
// e.g. stress builds an O(N²) distance matrix BEFORE any iteration, so capping its
// iterations is not enough. Caps are on node count (not iterations), plus a shared edge
// cap as a backstop for dense components (dagre is ~O(V·E), stress's SP is ~O(V·E)).
// Calibrated from measured per-component times so each engine stays comfortably under
// the 8s worker timeout at its cap (with margin for dense components and a busy machine):
// stress is ~O(N²) (~5s @1000 → lowest cap), layered ~O(V·E) (~8s @1800 → capped well
// below that), force/backbone iterative, tree near-linear. Above the cap → cheap grid.
const HEAVY_COMPONENT_CAP = {
  stress: 800,
  layered: 1200,
  tree: 2500,
  backbone: 1500,
  force: 1800,
} as const;
const HEAVY_EDGE_CAP = 8_000;

/** True when a (sub)graph is too big for a heavy engine to lay out within the time budget. */
function tooHeavy(view: LayoutInput, nodeCap: number): boolean {
  return view.nodes.length > nodeCap || view.edges.length > HEAVY_EDGE_CAP;
}

/**
 * Resolve the planner's requested engine against the per-engine budget caps: returns the
 * engine to actually run, plus why it was downgraded (if it was). Deliberately SEPARATE
 * from chooseEngine — the planner picks the ideal engine purely on graph shape, and this
 * is the single place that downgrades to grid for budget. The Smart leaf-cluster path
 * records the (requested, resolved, reason) triple for diagnostics. Mirrors tooHeavy, so
 * engines without a cap (grid/circular/radial — all cheap) always pass through.
 */
export function resolveEngineForBudget(
  requested: LayoutAlgorithm,
  nodeCount: number,
  edgeCount: number,
): { engine: LayoutAlgorithm; fallbackReason: FallbackReason } {
  const cap = HEAVY_COMPONENT_CAP[requested as keyof typeof HEAVY_COMPONENT_CAP];
  if (cap === undefined) return { engine: requested, fallbackReason: null };
  if (nodeCount > cap) return { engine: "grid", fallbackReason: "node-cap" };
  if (edgeCount > HEAVY_EDGE_CAP) return { engine: "grid", fallbackReason: "edge-cap" };
  return { engine: requested, fallbackReason: null };
}

/** Lay each component out with `engine`, falling back to grid for any oversized component. */
function cappedComponents(
  view: LayoutInput,
  nodeCap: number,
  engine: (sub: LayoutInput) => Positions,
): Positions {
  return layoutByComponents(view, (sub) =>
    tooHeavy(sub, nodeCap) ? gridLayout(sub) : engine(sub),
  );
}

export function layoutView(view: LayoutInput, options: LayoutOptions = {}): Positions {
  const { algorithm = "layered", direction = "LR" } = options;
  switch (algorithm) {
    case "smart":
      return smartLayout(view, {
        direction,
        groupBy: options.groupBy,
        density: options.density,
        communityOf: options.communityOf,
      }).nodes;
    case "tree":
      return cappedComponents(view, HEAVY_COMPONENT_CAP.tree, (sub) => treeLayout(sub, direction));
    case "radial":
      return layoutByComponents(view, radialLayout);
    case "circular":
      return layoutByComponents(view, circularLayout);
    case "grid":
      return gridLayout(view);
    case "backbone":
      return cappedComponents(view, HEAVY_COMPONENT_CAP.backbone, (sub) => backboneLayout(sub));
    case "stress":
      return cappedComponents(view, HEAVY_COMPONENT_CAP.stress, (sub) =>
        stressLayout(sub, options),
      );
    case "force":
      // Force runs as one whole-view simulation (charge spreads the components), so cap
      // on the total size rather than per component.
      return tooHeavy(view, HEAVY_COMPONENT_CAP.force)
        ? gridLayout(view)
        : forceLayout(view, options);
    default:
      return cappedComponents(view, HEAVY_COMPONENT_CAP.layered, (sub) =>
        dagreLayout(sub, direction, "network-simplex"),
      );
  }
}
