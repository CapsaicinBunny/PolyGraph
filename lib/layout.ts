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
import type { CompactGroupingSnapshot } from "./graph/grouping-snapshot";
import { coreness } from "./layout/backbone";
import { detectCommunities } from "./layout/community";
import {
  fiedlerOrder,
  orderByCircularBarycenter,
  rcmOrder,
  stableOrder,
  undirectedKey,
} from "./layout/ordering";
import { chooseEngine } from "./layout/planner";
import { graphShape } from "./layout/shape";
import { pivotMds } from "./layout/stress";
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

/**
 * How the Smart layout groups nodes into clusters — a grouping-mode KEY (Phase C1a).
 * The well-known built-ins are "directory" / "community" / "none"; provider-eligible
 * modes add "package" and "facet:<key>" (e.g. "facet:env"). A `string` because the set
 * is open (eligible groupable facets are discovered per graph); consumers branch only on
 * the built-ins and otherwise drive the layout from the injected grouping snapshot.
 */
export type GroupBy = string;

/** The always-available built-in grouping modes (no provider/manifest needed). */
export const BUILTIN_GROUP_BY = ["directory", "community", "none"] as const;

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
  /**
   * The injected grouping snapshot (Phase C1a). When present, the Smart layout builds
   * its cluster tree from it (the new grouping INPUT contract) rather than deriving
   * directory ancestry from node ids. Built once on the main thread; its typed arrays
   * transfer to the worker. See lib/graph/grouping-snapshot.ts.
   */
  groupingSnapshot?: CompactGroupingSnapshot;
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
 * Weighted undirected adjacency keyed by node id: summed edge weight per neighbor pair
 * (self-loops dropped, endpoints outside `ids` ignored, missing/non-positive weight → 1).
 * Map insertion order follows `ids`, so iteration over it stays deterministic.
 */
function weightedUndirectedAdjacency(
  ids: string[],
  edges: LayoutInput["edges"],
): Map<string, Map<string, number>> {
  const wadj = new Map<string, Map<string, number>>();
  for (const id of ids) wadj.set(id, new Map());
  for (const e of edges) {
    if (e.source === e.target || !wadj.has(e.source) || !wadj.has(e.target)) continue;
    const w = e.weight && e.weight > 0 ? e.weight : 1;
    wadj.get(e.source)!.set(e.target, (wadj.get(e.source)!.get(e.target) ?? 0) + w);
    wadj.get(e.target)!.set(e.source, (wadj.get(e.target)!.get(e.source) ?? 0) + w);
  }
  return wadj;
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

  // Directed outgoing edges drive ring depth (dependency flow); the weighted undirected
  // view (built below) drives angular barycenter ordering.
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const nd of view.nodes) {
    out.set(nd.id, []);
    indeg.set(nd.id, 0);
  }
  for (const e of view.edges) {
    if (!out.has(e.source) || !out.has(e.target)) continue;
    out.get(e.source)!.push(e.target);
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

  // Rings ordered from center outward; ring 0 anchored by the stable order.
  const rings = [...byDepth.keys()].sort((a, b) => a - b).map((d) => stableOrder(byDepth.get(d)!));

  // Weighted undirected adjacency — barycenters rank by relationship strength, so an
  // `extends` neighbor pulls a node toward it harder than an incidental `call`.
  const wadj = weightedUndirectedAdjacency(ids, view.edges);

  // Each ring's nodes sit at evenly spaced angles; this maps node → its current angle.
  const angleMapOf = (ring: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    ring.forEach((id, i) => m.set(id, ring.length > 0 ? (i / ring.length) * Math.PI * 2 : 0));
    return m;
  };
  const angleMaps = rings.map(angleMapOf);

  // Reorder ring r against the angles of an adjacent ring, using the circular mean of
  // weighted neighbor angles (no linear-index wrap artifacts).
  const reorderAgainst = (r: number, adj: number) => {
    const adjAngles = angleMaps[adj];
    rings[r] = orderByCircularBarycenter(rings[r], (id) => {
      const out: { angle: number; weight: number }[] = [];
      const nbrs = wadj.get(id);
      if (nbrs) {
        for (const [nb, w] of nbrs) {
          const a = adjAngles.get(nb);
          if (a !== undefined) out.push({ angle: a, weight: w });
        }
      }
      return out;
    });
    angleMaps[r] = angleMapOf(rings[r]);
  };

  // Initial outward pass, then a few alternating inward/outward sweeps to settle
  // crossings (bounded + deterministic). Ring 0 stays the fixed anchor.
  for (let r = 1; r < rings.length; r++) reorderAgainst(r, r - 1);
  const RING_SWEEPS = 4;
  for (let s = 0; s < RING_SWEEPS; s++) {
    if (s % 2 === 0) for (let r = rings.length - 2; r >= 1; r--) reorderAgainst(r, r + 1);
    else for (let r = 1; r < rings.length; r++) reorderAgainst(r, r - 1);
  }

  // Arc allowance per node (≈ widest card + breathing room) and the minimum radial gap
  // between consecutive rings. A ring's radius is the larger of "big enough to fit all
  // its nodes around the circumference" and "clear of the inner ring", so a crowded ring
  // grows outward instead of cramming its nodes into an overlapping circle.
  const ARC = 220;
  const RING_GAP = 220;
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  let prevRadius = 0;
  rings.forEach((ring, idx) => {
    const fitRadius = (ring.length * ARC) / (2 * Math.PI);
    const radius =
      idx === 0 ? (ring.length > 1 ? fitRadius : 0) : Math.max(prevRadius + RING_GAP, fitRadius);
    ring.forEach((id, i) => {
      const node = nodeById.get(id);
      if (!node) return;
      const angle = (i / ring.length) * Math.PI * 2;
      positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
    });
    prevRadius = radius;
  });
  return positions;
}

/**
 * Light crossing-reduction on a ring: repeated passes of adjacent transpositions that
 * lower the total circular index distance of incident edges. Swaps are restricted to
 * same-block (same-community) neighbors so community contiguity — including the wrap seam
 * — is preserved. Bounded passes + strict-improvement-only → deterministic.
 */
function refineRing(
  order: string[],
  edges: LayoutInput["edges"],
  sameBlock: (a: string, b: string) => boolean,
): string[] {
  const n = order.length;
  if (n < 4) return order;
  const adj = new Map<string, Set<string>>();
  for (const id of order) adj.set(id, new Set());
  for (const e of edges) {
    if (e.source === e.target) continue;
    const s = adj.get(e.source);
    const t = adj.get(e.target);
    if (s && t) {
      s.add(e.target);
      t.add(e.source);
    }
  }
  const arr = [...order];
  const indexOf = new Map(arr.map((id, i) => [id, i]));
  const cdist = (i: number, j: number): number => {
    const d = Math.abs(i - j);
    return Math.min(d, n - d);
  };
  const nodeCost = (id: string, at: number): number => {
    let c = 0;
    for (const nb of adj.get(id) ?? []) {
      const j = indexOf.get(nb);
      if (j !== undefined) c += cdist(at, j);
    }
    return c;
  };
  const PASSES = 4;
  for (let p = 0; p < PASSES; p++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = arr[i];
      const b = arr[j];
      if (!sameBlock(a, b)) continue;
      const before = nodeCost(a, i) + nodeCost(b, j);
      arr[i] = b;
      arr[j] = a;
      indexOf.set(a, j);
      indexOf.set(b, i);
      if (nodeCost(b, i) + nodeCost(a, j) < before) {
        improved = true;
      } else {
        arr[i] = a;
        arr[j] = b;
        indexOf.set(a, i);
        indexOf.set(b, j);
      }
    }
    if (!improved) break;
  }
  return arr;
}

/**
 * A component's nodes on a single circle. Communities are kept contiguous (ordered as a
 * coarse spectral graph), nodes within each are spectrally (Fiedler) ordered, then a light
 * same-community adjacent-swap pass trims residual crossings — so graph-adjacent nodes land
 * at adjacent angles instead of in arbitrary input order. Deterministic.
 */
function circularLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  if (n === 1) {
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  const ids = view.nodes.map((nd) => nd.id);
  const idSet = new Set(ids);
  const community = detectCommunities(ids, view.edges);
  const commOf = (id: string): string => community.get(id) ?? id;

  const byComm = new Map<string, string[]>();
  for (const id of ids)
    (byComm.get(commOf(id)) ?? byComm.set(commOf(id), []).get(commOf(id)))!.push(id);

  let order: string[];
  if (byComm.size <= 1) {
    // One community → spectral-order the whole ring (the common small-cycle case).
    order = fiedlerOrder(ids, view.edges);
  } else {
    // Order communities as a coarse graph, then concat each community's internal order.
    const coarse = new Map<string, { source: string; target: string }>();
    const internal = new Map<string, LayoutInput["edges"]>();
    for (const c of byComm.keys()) internal.set(c, []);
    for (const e of view.edges) {
      if (e.source === e.target || !idSet.has(e.source) || !idSet.has(e.target)) continue;
      const cs = commOf(e.source);
      const ct = commOf(e.target);
      if (cs === ct) internal.get(cs)!.push(e);
      else {
        const key = undirectedKey(cs, ct);
        if (!coarse.has(key)) coarse.set(key, { source: cs, target: ct });
      }
    }
    order = [];
    for (const c of fiedlerOrder([...byComm.keys()], [...coarse.values()])) {
      order.push(...fiedlerOrder(byComm.get(c)!, internal.get(c)!));
    }
  }
  order = refineRing(order, view.edges, (a, b) => commOf(a) === commOf(b));

  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  // Per-node arc length must clear the ACTUAL card size, or wide cards (files are 200px) crowd
  // and overlap on the ring (radial sizes its rings the same way). Use the widest/tallest card
  // present + breathing room, so a ring of small symbols still packs tightly.
  let maxExtent = 0;
  for (const nd of view.nodes) {
    const s = nodeSize(nd.kind);
    if (s.width > maxExtent) maxExtent = s.width;
    if (s.height > maxExtent) maxExtent = s.height;
  }
  const arc = maxExtent + 40;
  const radius = Math.max(160, (n * arc) / (2 * Math.PI));
  order.forEach((id, i) => {
    const node = nodeById.get(id);
    if (!node) return;
    const angle = (i / n) * Math.PI * 2;
    positions.set(...topLeft(node, Math.cos(angle) * radius, Math.sin(angle) * radius));
  });
  return positions;
}

/**
 * Grid layout. With edges present, orders nodes by Reverse Cuthill–McKee (keeps connected
 * nodes close in the 1-D sequence) and fills the grid in a serpentine (boustrophedon)
 * path, so that 1-D locality carries into 2-D — a row's end sits directly above the next
 * row's start, keeping consecutive nodes in adjacent cells. With no edges it falls back to
 * a tidy directory→path order in plain row-major (a clean table). Deterministic.
 */
function gridLayout(view: LayoutInput): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
  if (n === 0) return positions;
  const ids = view.nodes.map((nd) => nd.id);
  const localityMode = view.edges.length > 0;
  const order = localityMode ? rcmOrder(ids, view.edges) : stableOrder(ids);
  const nodeById = new Map(view.nodes.map((nd) => [nd.id, nd]));
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = 250;
  const cellH = 110;
  order.forEach((id, i) => {
    const node = nodeById.get(id);
    if (!node) return;
    const row = Math.floor(i / cols);
    const colInRow = i % cols;
    // Serpentine only in locality mode; edgeless stays plain row-major (tidy table).
    const col = localityMode && row % 2 === 1 ? cols - 1 - colInRow : colInRow;
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
  const VIRTUAL = " treeRoot";
  const ids = view.nodes.map((nd) => nd.id);

  // Children of each node (roots hang off the virtual root).
  const children = new Map<string, string[]>([[VIRTUAL, []]]);
  for (const id of ids) children.set(id, []);
  for (const id of ids) children.get(parent.get(id) ?? VIRTUAL)!.push(id);

  // Subtree sizes via reverse-BFS accumulation (iterative — safe for deep chains).
  const bfs: string[] = [];
  const sizeQueue = [VIRTUAL];
  for (let i = 0; i < sizeQueue.length; i++) {
    bfs.push(sizeQueue[i]);
    for (const c of children.get(sizeQueue[i]) ?? []) sizeQueue.push(c);
  }
  const subtree = new Map<string, number>(bfs.map((id) => [id, 1]));
  for (let i = bfs.length - 1; i >= 0; i--) {
    const v = bfs[i];
    if (v === VIRTUAL) continue;
    const p = parent.get(v) ?? VIRTUAL;
    subtree.set(p, subtree.get(p)! + subtree.get(v)!);
  }

  // Parent-edge weight (strongest relationship to the parent) + non-tree neighbors.
  const pairKey = undirectedKey;
  const pairW = new Map<string, number>();
  for (const e of view.edges) {
    if (e.source === e.target) continue;
    const k = pairKey(e.source, e.target);
    const w = e.weight ?? 1;
    if (w > (pairW.get(k) ?? 0)) pairW.set(k, w);
  }
  const parentWeight = (id: string): number => {
    const p = parent.get(id);
    return p == null ? 0 : (pairW.get(pairKey(id, p)) ?? 0);
  };
  const treeEdges = new Set<string>();
  for (const id of ids) {
    const p = parent.get(id);
    if (p != null) treeEdges.add(pairKey(id, p));
  }
  const nonTree = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of view.edges) {
    if (e.source === e.target || !nonTree.has(e.source) || !nonTree.has(e.target)) continue;
    if (treeEdges.has(pairKey(e.source, e.target))) continue;
    nonTree.get(e.source)!.push(e.target);
    nonTree.get(e.target)!.push(e.source);
  }

  const vertical = direction === "TB" || direction === "BT";
  const sample = nodeSize("file");
  const dx = (vertical ? sample.width : sample.height) + 40;
  const dy = (vertical ? sample.height : sample.width) + 80;
  // Lay the tree out with a sibling comparator. d3.stratify keeps children in their order
  // of appearance, so sorting rows by (parentId, cmp) fixes each parent's sibling order.
  const layoutWithOrder = (
    cmp: (a: string, b: string) => number,
  ): Map<string, { across: number; depth: number }> | null => {
    const data: StratifyDatum[] = view.nodes.map((nd) => ({
      id: nd.id,
      parentId: parent.get(nd.id) ?? VIRTUAL,
    }));
    data.push({ id: VIRTUAL, parentId: null });
    data.sort((a, b) => {
      const pa = a.parentId ?? "";
      const pb = b.parentId ?? "";
      return pa !== pb ? (pa < pb ? -1 : 1) : cmp(a.id, b.id);
    });
    try {
      const h = stratify<StratifyDatum>()
        .id((d) => d.id)
        .parentId((d) => d.parentId)(data);
      const laid = d3tree<StratifyDatum>().nodeSize([dx, dy])(h);
      const out = new Map<string, { across: number; depth: number }>();
      laid.each((dnode) => {
        if (dnode.data.id !== VIRTUAL) out.set(dnode.data.id, { across: dnode.x, depth: dnode.y });
      });
      return out;
    } catch {
      return null; // stratify only throws on a malformed forest
    }
  };

  const tie = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Initial order: bigger subtrees first, then stronger parent-edge, then stable id.
  const initial = layoutWithOrder(
    (a, b) => subtree.get(b)! - subtree.get(a)! || parentWeight(b) - parentWeight(a) || tie(a, b),
  );
  if (!initial) return gridLayout(view);

  // One barycenter sweep: order siblings by the mean cross-axis position of their NON-tree
  // neighbors, pulling cross-link endpoints together so secondary edges cross less.
  const bary = (id: string): number => {
    let sum = 0;
    let cnt = 0;
    for (const nb of nonTree.get(id) ?? []) {
      const pp = initial.get(nb);
      if (pp) {
        sum += pp.across;
        cnt++;
      }
    }
    return cnt > 0 ? sum / cnt : (initial.get(id)?.across ?? 0);
  };
  const placed = layoutWithOrder((a, b) => bary(a) - bary(b) || tie(a, b)) ?? initial;

  for (const [id, p] of placed) {
    const node = nodeById.get(id);
    if (!node) continue;
    let cx: number;
    let cy: number;
    switch (direction) {
      case "BT":
        cx = p.across;
        cy = -p.depth;
        break;
      case "LR":
        cx = p.depth;
        cy = p.across;
        break;
      case "RL":
        cx = -p.depth;
        cy = p.across;
        break;
      default:
        cx = p.across;
        cy = p.depth;
    }
    positions.set(...topLeft(node, cx, cy));
  }
  return positions;
}

/**
 * Backbone (core-periphery): pick a dense core via an adaptive k-core threshold, lay it out
 * with force, then hang the low-coreness periphery off it in BFS waves — each leaf fanned
 * OUTWARD from the core centroid (away from the dense middle) off its strongest-weight placed
 * neighbor, with a final overlap relax. Falls back to a tidy tree when there's no real core.
 */
function backboneLayout(view: LayoutInput): Positions {
  const ids = view.nodes.map((n) => n.id);
  const core = coreness(ids, view.edges);
  let maxCore = 0;
  for (const c of core.values()) if (c > maxCore) maxCore = c;
  if (maxCore < 2) return treeLayout(view, "TB");

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));

  // Adaptive core threshold: raise it past 2 until the core is a real backbone (not most
  // of the graph), so a dense codebase doesn't end up with nearly everything in the core.
  const atLeast = (k: number) =>
    ids.reduce((acc, id) => acc + ((core.get(id) ?? 0) >= k ? 1 : 0), 0);
  let threshold = 2;
  while (threshold < maxCore && atLeast(threshold) > 0.4 * ids.length) threshold++;
  const coreSet = new Set(ids.filter((id) => (core.get(id) ?? 0) >= threshold));
  const positions = forceLayout({
    nodes: view.nodes.filter((n) => coreSet.has(n.id)),
    edges: view.edges.filter((e) => coreSet.has(e.source) && coreSet.has(e.target)),
  });

  // Weighted undirected adjacency → anchor each satellite to its STRONGEST placed neighbor.
  const wadj = weightedUndirectedAdjacency(ids, view.edges);

  const centerOf = (id: string): XYPosition => {
    const p = positions.get(id) ?? { x: 0, y: 0 };
    const s = nodeSize(nodeById.get(id)?.kind ?? "");
    return { x: p.x + s.width / 2, y: p.y + s.height / 2 };
  };
  // Core centroid: satellites fan OUTWARD from it (away from the dense core) so leaves don't
  // land in the pockets between core nodes.
  let cgx = 0;
  let cgy = 0;
  for (const id of coreSet) {
    const c = centerOf(id);
    cgx += c.x;
    cgy += c.y;
  }
  const coreCount = Math.max(1, coreSet.size);
  cgx /= coreCount;
  cgy /= coreCount;

  const placed = new Set(coreSet);
  const fan = new Map<string, number>();
  const SAT_SPACING = 150; // satellite spacing → nearest satellites ≈ a card apart
  const frontier = () =>
    ids
      .filter(
        (id) => !placed.has(id) && [...(wadj.get(id)?.keys() ?? [])].some((nb) => placed.has(nb)),
      )
      .sort(cmp);
  for (let wave = frontier(); wave.length > 0; wave = frontier()) {
    for (const id of wave) {
      if (placed.has(id)) continue;
      // Anchor = the placed neighbor with the strongest summed relationship weight.
      let anchor: string | undefined;
      let bestW = -1;
      for (const [nb, w] of wadj.get(id) ?? []) {
        if (
          placed.has(nb) &&
          (w > bestW || (w === bestW && (anchor === undefined || nb < anchor)))
        ) {
          bestW = w;
          anchor = nb;
        }
      }
      const node = nodeById.get(id);
      if (!anchor || !node) continue;
      const c = centerOf(anchor);
      const k = fan.get(anchor) ?? 0;
      fan.set(anchor, k + 1);
      // Fan OUTWARD from the core centroid (away from the dense core) so leaves clear it,
      // spread within the outward half by a golden-angle offset; radius grows with the index.
      const outward = Math.atan2(c.y - cgy, c.x - cgx);
      const spread = (((k * 2.39996) % (Math.PI * 2)) - Math.PI) * 0.4; // ±0.4π around outward
      const angle = outward + spread;
      const r = SAT_SPACING * (1.4 + Math.sqrt(k));
      positions.set(...topLeft(node, c.x + Math.cos(angle) * r, c.y + Math.sin(angle) * r));
      placed.add(id);
    }
  }
  // Detached leftovers: a grid just below the actual content (not a hard-coded offset).
  let maxY = 0;
  for (const [id, p] of positions)
    maxY = Math.max(maxY, p.y + nodeSize(nodeById.get(id)?.kind ?? "").height);
  const leftover = ids.filter((id) => !placed.has(id)).sort(cmp);
  const cols = Math.max(1, Math.ceil(Math.sqrt(leftover.length)));
  leftover.forEach((id, i) => {
    const node = nodeById.get(id);
    if (node)
      positions.set(...topLeft(node, (i % cols) * 250, maxY + 200 + Math.floor(i / cols) * 110));
  });

  // Final global pass: separate satellites whose fans overlap across different anchors (expanding
  // the layout if a dense core can't be separated at its current scale).
  deOverlap(positions, view);
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
  // Carry edge weight so heavier relationships (extends/implements) pull harder than calls.
  type Link = { source: string; target: string; weight: number };
  const links: Link[] = view.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, weight: e.weight ?? 1 }));

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-1200).distanceMax(2200))
    .force(
      "link",
      forceLink<SimNode, Link>(links)
        .id((d) => d.id)
        .distance(220)
        .strength((l) => Math.min(0.7, 0.2 + 0.06 * (l.weight ?? 1))),
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
// A component uses true stress majorization (webcola) only when small AND not too dense —
// cola is ~O(V·E), so cap both node and edge count; everything else switches to PivotMDS.
const DENSE_STRESS_MAX = 600;
const DENSE_STRESS_EDGE_CAP = 4_000;
// PivotMDS work budget. Cost ≈ k·(V+E) [BFS from k pivots] + n·k² [Gram build/eigen] + the
// bounded overlap-relax passes. Calibrated from a measured n=6000 run (~26M units → ~1.8s,
// ~15M units/s); ~80M units keeps the worst permitted component near ~5s, well under the 8s
// worker timeout. Above this → cheap grid. Pivots scale with √n (capped at 50).
const MAX_STRESS_WORK = 80_000_000;
const stressPivots = (n: number): number => Math.min(50, Math.max(8, Math.ceil(Math.sqrt(n))));
const stressWork = (n: number, m: number, pivots: number): number =>
  pivots * (n + m) + n * pivots * pivots + n * 200 * 9;

/**
 * Push overlapping cards apart with a few bounded spatial-hash passes. PivotMDS places by
 * graph distance and can leave cards overlapping; this is the cheap O(n) cleanup (the dense
 * path gets cola's avoidOverlaps instead). Deterministic: ids sorted, each pair handled once.
 */
/** De-overlap cards in place. Returns true if it reached a clean state, false if it stopped on
 * the work/pass budget with overlaps remaining (the caller can then expand + retry). */
function relaxOverlaps(centers: Map<string, XYPosition>, view: LayoutInput): boolean {
  const n = view.nodes.length;
  if (n < 2) return true;
  // Index-based (typed arrays) so the O(pairs) inner loop avoids Map lookups. Nodes are
  // visited in sorted-id order for determinism (index order == id order after this sort).
  const ids = view.nodes.map((nd) => nd.id).sort();
  const sizeOf = new Map(view.nodes.map((nd) => [nd.id, nodeSize(nd.kind)]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ws = new Float64Array(n);
  const hs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = centers.get(ids[i]) ?? { x: 0, y: 0 };
    const s = sizeOf.get(ids[i])!;
    xs[i] = c.x;
    ys[i] = c.y;
    ws[i] = s.width;
    hs[i] = s.height;
  }
  const CELL = 260;
  const PAD = 16;
  // Jacobi relaxation: each pass computes every pair's push from ONE snapshot and applies the
  // accumulated displacement at the end. (Applying pushes immediately makes a card squeezed
  // between two others oscillate instead of settle.) Overlapping cards push each other outward,
  // so the layout expands until it fits. Breaks as soon as a pass is clean.
  const PASSES = 600;
  // Hard ceiling on total pair-checks. Dense graphs cluster many cards into the same grid cells,
  // making a pass O(Σ cell²) → potentially O(n²); the cap keeps it bounded (residual overlap on
  // pathologically dense inputs is an accepted trade for bounded time). Raised once the loop went
  // index-based (~4× faster per check): a hub-heavy stress layout needs more passes to expand its
  // dense core, and ~100M fast checks still finishes well under the 8s worker timeout.
  const MAX_CHECKS = 100_000_000;
  let checks = 0;
  let converged = false;
  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);
  relax: for (let pass = 0; pass < PASSES; pass++) {
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(xs[i] / CELL)},${Math.floor(ys[i] / CELL)}`;
      (grid.get(key) ?? grid.set(key, []).get(key))!.push(i);
      dispX[i] = 0;
      dispY[i] = 0;
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(xs[i] / CELL);
      const gy = Math.floor(ys[i] / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const others = grid.get(`${gx + dx},${gy + dy}`);
          if (!others) continue;
          for (const j of others) {
            if (j <= i) continue; // each pair once, in (sorted) index order
            if (++checks > MAX_CHECKS) break relax; // bounded work; prior passes already applied
            const ox = (ws[i] + ws[j]) / 2 + PAD - Math.abs(xs[j] - xs[i]);
            const oy = (hs[i] + hs[j]) / 2 + PAD - Math.abs(ys[j] - ys[i]);
            if (ox <= 0 || oy <= 0) continue;
            // Separate along the axis of least penetration; accumulate (don't apply yet).
            if (ox < oy) {
              const push = ((xs[j] - xs[i] >= 0 ? 1 : -1) * ox) / 2;
              dispX[i] -= push;
              dispX[j] += push;
            } else {
              const push = ((ys[j] - ys[i] >= 0 ? 1 : -1) * oy) / 2;
              dispY[i] -= push;
              dispY[j] += push;
            }
            moved = true;
          }
        }
      }
    }
    if (!moved) {
      converged = true;
      break;
    }
    for (let i = 0; i < n; i++) {
      xs[i] += dispX[i];
      ys[i] += dispY[i];
    }
  }
  for (let i = 0; i < n; i++) {
    const c = centers.get(ids[i]);
    if (c) {
      c.x = xs[i];
      c.y = ys[i];
    }
  }
  return converged;
}

/** Scale positions geometrically about their centroid — thins a layout too dense for overlap
 * removal to separate at its current scale. */
function expandAround(centers: Map<string, XYPosition>, factor: number): void {
  let cx = 0;
  let cy = 0;
  let count = 0;
  for (const c of centers.values()) {
    cx += c.x;
    cy += c.y;
    count++;
  }
  if (count === 0) return;
  cx /= count;
  cy /= count;
  for (const c of centers.values()) {
    c.x = cx + (c.x - cx) * factor;
    c.y = cy + (c.y - cy) * factor;
  }
}

/**
 * De-overlap in place, expanding the layout when relaxation can't separate a too-dense region.
 * PivotMDS (and a hub's fan) can pack cards denser than the bounded Jacobi relax can pull apart
 * at one scale; each expansion drops the local density geometrically so a few rounds converge to
 * overlap-free. Deterministic (relax + centroid scale are both deterministic).
 */
function deOverlap(centers: Map<string, XYPosition>, view: LayoutInput): void {
  if (relaxOverlaps(centers, view)) return;
  for (let i = 0; i < 5; i++) {
    expandAround(centers, 1.4);
    if (relaxOverlaps(centers, view)) return;
  }
}

/** Dense stress majorization (webcola): true SMACOF + overlap avoidance, for smaller comps. */
function denseStressLayout(view: LayoutInput, options: LayoutOptions): Positions {
  const positions: Positions = new Map();
  const n = view.nodes.length;
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

/** PivotMDS (landmark) stress for large components — near-linear, then scaled + de-overlapped. */
function sparseStressLayout(view: LayoutInput, pivots: number): Positions {
  const positions: Positions = new Map();
  const ids = view.nodes.map((nd) => nd.id).sort();
  const centers = pivotMds(ids, view.edges, Math.min(pivots, ids.length));
  // Scale graph-distance units to pixels so connected cards sit ~a card-and-a-half apart.
  let sum = 0;
  let cnt = 0;
  for (const e of view.edges) {
    const a = centers.get(e.source);
    const b = centers.get(e.target);
    if (a && b) {
      sum += Math.hypot(a.x - b.x, a.y - b.y);
      cnt++;
    }
  }
  const meanLen = cnt > 0 ? sum / cnt : 0;
  const scale = meanLen > 1e-6 ? 320 / meanLen : 1;
  for (const c of centers.values()) {
    c.x *= scale;
    c.y *= scale;
  }
  // PivotMDS collapses symmetric nodes (e.g. all of a hub's leaves, equidistant from it and each
  // other) onto near-identical points. The overlap relax can't pull a dense coincident pile apart
  // within its pass budget, so deterministically fan each co-located cluster out in a golden-angle
  // spiral first (sorted ids → stable); relax then only has to fine-tune. Without this, stress on
  // hub-heavy graphs leaves hundreds of overlapping cards.
  const bucket = new Map<string, number>();
  for (const id of ids) {
    const c = centers.get(id);
    if (!c) continue;
    const key = `${Math.round(c.x / 120)},${Math.round(c.y / 120)}`;
    const k = bucket.get(key) ?? 0;
    bucket.set(key, k + 1);
    if (k > 0) {
      const angle = k * 2.399963229; // golden angle
      const r = 120 * Math.sqrt(k); // ~card-sized spacing so the spiral itself doesn't overlap
      c.x += Math.cos(angle) * r;
      c.y += Math.sin(angle) * r;
    }
  }
  deOverlap(centers, view);
  for (const nd of view.nodes) {
    const c = centers.get(nd.id) ?? { x: 0, y: 0 };
    positions.set(...topLeft(nd, c.x, c.y));
  }
  return positions;
}

/**
 * Stress layout. Small, not-too-dense components use true stress majorization (SMACOF +
 * overlap avoidance, ~O(V·E) — node + edge capped); larger ones use PivotMDS (landmark MDS,
 * near-linear), gated by an explicit work-budget estimate so even a dense PivotMDS run stays
 * under the worker timeout. Over budget → cheap grid. Self-guarding for any caller.
 */
function stressLayout(view: LayoutInput, options: LayoutOptions = {}): Positions {
  const n = view.nodes.length;
  if (n === 0) return new Map();
  if (n === 1) {
    const positions: Positions = new Map();
    positions.set(...topLeft(view.nodes[0], 0, 0));
    return positions;
  }
  const m = view.edges.length;
  const pivots = stressPivots(n);
  if (n <= DENSE_STRESS_MAX && m <= DENSE_STRESS_EDGE_CAP) {
    try {
      return denseStressLayout(view, options);
    } catch {
      // webcola can fail to run in some bundles (notably the production Web Worker). Fall back to
      // the pure-TS PivotMDS path so Stress still produces a layout instead of throwing (which
      // would otherwise hang the worker until the 8s timeout).
      return sparseStressLayout(view, pivots);
    }
  }
  if (stressWork(n, m, pivots) > MAX_STRESS_WORK) return gridLayout(view);
  return sparseStressLayout(view, pivots);
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
    previousPositions: options.previousPositions,
    groupingSnapshot: options.groupingSnapshot,
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
// Calibrated from measured per-component times so each engine stays comfortably under the
// 8s worker timeout at its cap (with margin for dense components and a busy machine):
// layered ~O(V·E) (~8s @1800 → capped well below that), force/backbone iterative, tree
// near-linear. Stress is hybrid — true majorization up to DENSE_STRESS_MAX, then PivotMDS
// (near-linear), so it scales far higher than the old O(N²) cap. Above the cap → cheap grid.
const HEAVY_COMPONENT_CAP = {
  stress: 6000,
  layered: 1200,
  // backbone is the STRUCTURAL fallback for an over-cap heavy component (below), so its cap
  // is set above typical "Reveal detail" expanded-graph sizes (~1.5-2.5k nodes) — it shows
  // the core instead of dropping to a meaningless grid. The 8s worker timeout backstops any
  // dense outlier that creeps toward the edge cap.
  tree: 2500,
  backbone: 2500,
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
  const overNodes = nodeCount > cap;
  // Stress is near-linear in edges (PivotMDS for large comps), so the dense edge backstop
  // doesn't apply to it; the other heavy engines are ~O(V·E) and keep it.
  const overEdges = requested !== "stress" && edgeCount > HEAVY_EDGE_CAP;
  if (!overNodes && !overEdges) return { engine: requested, fallbackReason: null };
  const reason: FallbackReason = overNodes ? "node-cap" : "edge-cap";
  // Prefer a STRUCTURAL fallback — backbone shows the dependency core, not the meaningless
  // alphabetical grid users complained about — whenever the component still fits backbone's
  // budget. Only a component too big even for backbone (or backbone itself overflowing)
  // falls all the way to the cheap grid.
  if (
    requested !== "backbone" &&
    nodeCount <= HEAVY_COMPONENT_CAP.backbone &&
    edgeCount <= HEAVY_EDGE_CAP
  ) {
    return { engine: "backbone", fallbackReason: reason };
  }
  return { engine: "grid", fallbackReason: reason };
}

/**
 * Human summary of any Smart leaf clusters the budget guard downgraded to a cheaper engine,
 * for a "layout simplified" indicator — so a grid fallback isn't mistaken for the chosen
 * engine producing a poor result. Returns null when nothing was downgraded. Groups by the
 * requested → actual substitution; deterministic order.
 */
export function layoutFallbackSummary(clusters: ClusterBox[]): string | null {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const counts = new Map<string, number>();
  for (const c of clusters) {
    if (c.fallbackReason == null || !c.requestedEngine || !c.engine) continue;
    const key = `${cap(c.requestedEngine)} → ${cap(c.engine)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, n]) => (n > 1 ? `${k} (${n} areas)` : k));
  return `Layout simplified — ${parts.join(", ")} (too large for the chosen engine)`;
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
        previousPositions: options.previousPositions,
        groupingSnapshot: options.groupingSnapshot,
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
      // stressLayout self-guards per component (dense node+edge cap → cola; else a PivotMDS
      // work-budget estimate → grid if too heavy), so no separate node cap is needed here.
      return layoutByComponents(view, (sub) => stressLayout(sub, options));
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
