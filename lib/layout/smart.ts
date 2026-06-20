import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { ViewEdgeKind } from "../aggregate";
import {
  type ClusterBox,
  type FallbackReason,
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
  type LayoutInput,
  type LayoutResult,
  layoutView,
  nodeSize,
  resolveEngineForBudget,
  type XYPosition,
} from "../layout";
import { buildClusterTree, type ClusterTreeNode } from "./clusters";
import { detectCommunities } from "./community";
import { edgeKey } from "./ordering";
import { candidateEngines, chooseEngine } from "./planner";
import { stronglyConnectedComponents } from "./scc";
import { type GraphShape, graphShape } from "./shape";
import { layoutScore } from "./score";

const PADDING = 24;
const HEADER_H = 26;

type Item = { id: string; width: number; height: number };
type Centers = Map<string, XYPosition>;
/** A collapsed item-level edge between child boxes/nodes, carrying aggregated weight + count. */
type ItemEdge = { source: string; target: string; weight: number; count: number };

interface ClusterLayout {
  width: number;
  height: number;
  positions: Map<string, XYPosition>; // node top-lefts, local to this cluster's top-left
  clusters: ClusterBox[]; // descendant boxes, local to this cluster's top-left
  // Set when this is a leaf cluster laid out by the planner; the parent copies them onto
  // the cluster's box. Undefined for container clusters (item-box placement).
  engine?: LayoutAlgorithm;
  requestedEngine?: LayoutAlgorithm;
  fallbackReason?: FallbackReason;
}

/** The item (child cluster id, or the node id itself) that `nodeId` maps to within cluster `sx`. */
function itemOf(sx: string, nodeId: string, ancestry: Map<string, string[]>): string | null {
  const anc = ancestry.get(nodeId) ?? [];
  if (sx === "") return anc.length > 0 ? anc[0] : nodeId;
  const i = anc.indexOf(sx);
  if (i === -1) return null; // node is not inside this cluster
  return i + 1 < anc.length ? anc[i + 1] : nodeId;
}

/** Place sized items with dagre (weighted by relationship strength); returns item centers. */
function dagreItems(
  items: { id: string; width: number; height: number }[],
  edges: ItemEdge[],
  direction: LayoutDirection,
  spacing: number,
): Map<string, XYPosition> {
  const centers = new Map<string, XYPosition>();
  if (items.length === 0) return centers;
  const vertical = direction === "TB" || direction === "BT";
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: (vertical ? 36 : 24) * spacing,
    ranksep: (vertical ? 70 : 90) * spacing,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const it of items) g.setNode(it.id, { width: it.width, height: it.height });
  for (const e of edges) {
    if (e.source !== e.target && g.hasNode(e.source) && g.hasNode(e.target)) {
      const w = e.weight ?? 1;
      g.setEdge(e.source, e.target, { weight: w > 0 ? w : 1 });
    }
  }
  dagre.layout(g);
  for (const it of items) {
    const laid = g.node(it.id);
    centers.set(it.id, { x: laid?.x ?? 0, y: laid?.y ?? 0 }); // dagre node x/y is the center
  }
  return centers;
}

/** Row-major grid of items (centers), sized to the largest item so none overlap. Used when a cluster has no internal edges. */
function gridItems(items: Item[], spacing: number): Centers {
  const centers: Centers = new Map();
  const n = items.length;
  if (n === 0) return centers;
  const cols = Math.ceil(Math.sqrt(n));
  let cellW = 0;
  let cellH = 0;
  for (const it of items) {
    cellW = Math.max(cellW, it.width);
    cellH = Math.max(cellH, it.height);
  }
  const stepX = cellW + 40 * spacing;
  const stepY = cellH + 40 * spacing;
  items.forEach((it, i) => {
    centers.set(it.id, { x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY });
  });
  return centers;
}

/** Items evenly spaced on a ring around the origin (centers). Used inside SCC super-items. */
function circularItems(items: Item[], spacing: number): Centers {
  const centers: Centers = new Map();
  const n = items.length;
  if (n === 0) return centers;
  if (n === 1) {
    centers.set(items[0].id, { x: 0, y: 0 });
    return centers;
  }
  let extent = 0;
  for (const it of items) extent = Math.max(extent, Math.hypot(it.width, it.height));
  // Radius from a per-item arc allowance so cards never crowd on the ring.
  const radius = Math.max(160 * spacing, (n * (extent + 30 * spacing)) / (2 * Math.PI));
  items.forEach((it, i) => {
    const angle = (i / n) * Math.PI * 2;
    centers.set(it.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return centers;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Force-directed placement of items (centers) via fixed synchronous ticks. Deterministic (no RNG). */
function forceItems(
  items: Item[],
  edges: { source: string; target: string }[],
  spacing: number,
): Centers {
  const centers: Centers = new Map();
  if (items.length === 0) return centers;
  const simNodes: SimNode[] = items.map((it) => ({ id: it.id }));
  const ids = new Set(items.map((it) => it.id));
  const links = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  let radius = 60;
  for (const it of items) radius = Math.max(radius, Math.hypot(it.width, it.height) / 2 + 20);

  const sim = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-1200).distanceMax(2200))
    .force(
      "link",
      forceLink<SimNode, { source: string; target: string }>(links)
        .id((d) => d.id)
        .distance(radius * 2.2 * spacing)
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(radius * spacing))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();
  items.forEach((it, i) => centers.set(it.id, { x: simNodes[i].x ?? 0, y: simNodes[i].y ?? 0 }));
  return centers;
}

type Placement = "grid" | "dagre" | "force" | "circular";

/**
 * Map the planner's engine choice onto a CONTAINER's box-placement strategy (arranging child
 * boxes, not raw nodes): hierarchical → dagre ranks, a small cycle → a ring, dense/cyclic/
 * hub-heavy → force, nothing connecting → grid. So the top-level package/subsystem boxes are
 * arranged by the same shape-aware planner the leaf clusters use — not a two-rule heuristic.
 */
function containerPlacement(engine: LayoutAlgorithm): Placement {
  switch (engine) {
    case "grid":
      return "grid";
    case "layered":
    case "tree":
      return "dagre";
    case "circular":
      return "circular";
    default:
      return "force"; // force / stress / backbone / radial → force-place the boxes
  }
}

/** Stable source-then-target edge order, so engine output is invariant to input edge order. */
function bySourceTarget(
  a: { source: string; target: string },
  b: { source: string; target: string },
): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  return 0;
}

type AggEdge = {
  source: string;
  target: string;
  kind: ViewEdgeKind;
  count: number;
  weight: number;
};

/**
 * Internal edges of a node set, with parallel relationships (several kinds between the same
 * pair) aggregated into one weighted edge: summed count + summed precomputed weight, the
 * heaviest single contributor's kind kept as representative. This is what lets the planner
 * and the weighted engines treat an `extends`/`implements` pair as stronger than many `call`s.
 */
export function aggregateInternalEdges(edges: LayoutInput["edges"], ids: Set<string>): AggEdge[] {
  const agg = new Map<string, AggEdge>();
  const maxW = new Map<string, number>();
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    const key = edgeKey(e.source, e.target);
    const w = e.weight ?? 0;
    const c = e.count ?? 1;
    const cur = agg.get(key);
    if (cur) {
      cur.count += c;
      cur.weight += w;
      if (w > (maxW.get(key) ?? 0)) {
        maxW.set(key, w);
        if (e.kind) cur.kind = e.kind;
      }
    } else {
      agg.set(key, {
        source: e.source,
        target: e.target,
        kind: e.kind ?? "import",
        count: c,
        weight: w,
      });
      maxW.set(key, w);
    }
  }
  return [...agg.values()].sort(bySourceTarget);
}

interface EngineChoice {
  engine: LayoutAlgorithm;
  requestedEngine: LayoutAlgorithm;
  fallbackReason: FallbackReason;
  laid: Map<string, XYPosition>;
}

// Score-multiple candidates only for clusters in this band: big enough that the engine
// choice matters, small enough that running 2-3 layouts + O(E²+N²) scoring stays cheap.
// Bounded on EDGES too — crossing counting is O(E²), so a small-but-dense cluster (many
// edges among ≤120 nodes) would otherwise slip past the node cap and cost millions of
// segment-pair checks per candidate.
const SCORE_MIN_NODES = 8;
const SCORE_MAX_NODES = 120;
const SCORE_MAX_EDGES = 1_200;
const SCORE_MAX_PAIR_CHECKS = 1_000_000;

/**
 * Pick a leaf cluster's engine and lay it out. For ambiguous medium clusters this generates
 * the planner's candidate engines, runs each, and keeps the lowest-crossing result; for
 * clear-cut or large/tiny clusters it runs the single primary engine. `requestedEngine` is
 * always the planner's first choice (what it asked for); `engine` is what actually ran.
 */
function selectEngineAndLayout(
  nodeIds: string[],
  clusterEdges: LayoutInput["edges"],
  shape: GraphShape,
  direction: LayoutDirection,
  spacing: number,
  kindOf: Map<string, string>,
  previousPositions: Map<string, XYPosition> | undefined,
): EngineChoice {
  const requestedEngine = chooseEngine(shape);
  const clusterNodes = nodeIds.map((id) => ({ id, kind: kindOf.get(id) ?? "" }));
  // Engines that seed (force, dense stress) read previousPositions; the leaf box is then
  // re-normalized, so the prior RELATIVE arrangement is kept while the box re-centers.
  const run = (engine: LayoutAlgorithm, fallbackReason: FallbackReason) => ({
    engine,
    fallbackReason,
    laid: layoutView(
      { nodes: clusterNodes, edges: clusterEdges },
      { algorithm: engine, direction, density: spacing, previousPositions },
    ),
  });

  // Resolve each candidate against the budget, then dedupe — two requested engines that both
  // fall back to the same engine (e.g. grid) must not be laid out and scored twice.
  const resolved: { engine: LayoutAlgorithm; fallbackReason: FallbackReason }[] = [];
  const seen = new Set<LayoutAlgorithm>();
  for (const cand of candidateEngines(shape)) {
    const r = resolveEngineForBudget(cand, shape.nodeCount, shape.edgeCount);
    if (!seen.has(r.engine)) {
      seen.add(r.engine);
      resolved.push(r);
    }
  }

  // Gate scoring on nodes AND edges: crossing counting is O(E²), so cap edge count and the
  // total pair-check work so a dense cluster can't blow past the node safeguards.
  const m = clusterEdges.length;
  const canScore =
    resolved.length > 1 &&
    nodeIds.length >= SCORE_MIN_NODES &&
    nodeIds.length <= SCORE_MAX_NODES &&
    m <= SCORE_MAX_EDGES &&
    (m * (m - 1)) / 2 <= SCORE_MAX_PAIR_CHECKS;
  if (!canScore) {
    return { ...run(resolved[0].engine, resolved[0].fallbackReason), requestedEngine };
  }

  // Disable the flow (backward-edge) term for substantially-cyclic clusters, where there's no
  // meaningful dependency direction to violate.
  const flowWeight = shape.sccNodeRatio > 0.3 ? 0 : 4;
  const scoreOf = (laid: Map<string, XYPosition>): number => {
    const centers = new Map<string, { x: number; y: number }>();
    const sizes = new Map<string, { w: number; h: number }>();
    for (const id of nodeIds) {
      const p = laid.get(id) ?? { x: 0, y: 0 };
      const s = nodeSize(kindOf.get(id) ?? "");
      centers.set(id, { x: p.x + s.width / 2, y: p.y + s.height / 2 });
      sizes.set(id, { w: s.width, h: s.height });
    }
    return layoutScore(centers, sizes, clusterEdges, direction, flowWeight);
  };

  // The planner's pick (resolved[0]) is the default; an alternative replaces it only if it
  // scores meaningfully better (hysteresis), so a marginal win doesn't override the shape
  // heuristic on noise.
  const scored = resolved.map((r) => ({ ...r, ...run(r.engine, r.fallbackReason) }));
  const withScores = scored.map((s) => ({ ...s, score: scoreOf(s.laid) }));
  const primary = withScores[0];
  let best = primary;
  for (let i = 1; i < withScores.length; i++) {
    if (withScores[i].score < primary.score * 0.85 && withScores[i].score < best.score) {
      best = withScores[i];
    }
  }
  return {
    engine: best.engine,
    requestedEngine,
    fallbackReason: best.fallbackReason,
    laid: best.laid,
  };
}

/**
 * Leaf cluster (no child containers): pick the engine from the node subgraph's shape via the
 * authoritative planner (with candidate scoring), guard it against the per-engine budget, and
 * run that real engine on the cluster's nodes. Returns node positions inset into the cluster
 * box, plus the (requested, resolved, reason) triple the parent records on the box.
 */
function layoutLeafCluster(
  node: ClusterTreeNode,
  direction: LayoutDirection,
  kindOf: Map<string, string>,
  edges: LayoutInput["edges"],
  spacing: number,
  isRoot: boolean,
  previousPositions: Map<string, XYPosition> | undefined,
): ClusterLayout {
  const nodeIds = [...node.nodeIds].sort();
  if (nodeIds.length === 0) return { width: 0, height: 0, positions: new Map(), clusters: [] };
  const pad = PADDING * spacing;
  const ids = new Set(nodeIds);
  const clusterEdges = aggregateInternalEdges(edges, ids);

  const shape = graphShape(nodeIds, clusterEdges);
  const { engine, requestedEngine, fallbackReason, laid } = selectEngineAndLayout(
    nodeIds,
    clusterEdges,
    shape,
    direction,
    spacing,
    kindOf,
    previousPositions,
  );

  // Normalize the engine's positions into the cluster's inset content origin and size the box
  // (same inset/box math as the container path below, so boxes stay consistent).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of nodeIds) {
    const p = laid.get(id) ?? { x: 0, y: 0 };
    const s = nodeSize(kindOf.get(id) ?? "");
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + s.width > maxX) maxX = p.x + s.width;
    if (p.y + s.height > maxY) maxY = p.y + s.height;
  }
  const dx = (isRoot ? 0 : pad) - minX;
  const dy = (isRoot ? 0 : pad + HEADER_H) - minY;
  const positions = new Map<string, XYPosition>();
  for (const id of nodeIds) {
    const p = laid.get(id) ?? { x: 0, y: 0 };
    positions.set(id, { x: p.x + dx, y: p.y + dy });
  }
  return {
    width: isRoot ? maxX - minX : maxX - minX + 2 * pad,
    height: isRoot ? maxY - minY : maxY - minY + 2 * pad + HEADER_H,
    positions,
    clusters: [],
    engine,
    requestedEngine,
    fallbackReason,
  };
}

function layoutCluster(
  node: ClusterTreeNode,
  depth: number,
  direction: LayoutDirection,
  ancestry: Map<string, string[]>,
  kindOf: Map<string, string>,
  edges: LayoutInput["edges"],
  spacing: number,
  previousPositions: Map<string, XYPosition> | undefined,
): ClusterLayout {
  const isRoot = node.id === "";
  const pad = PADDING * spacing;
  const childKeys = [...node.children.keys()].sort();

  // A leaf cluster (no child containers) is laid out by the shape planner running a real
  // per-node engine. Container clusters keep the item-box placement below.
  if (childKeys.length === 0) {
    return layoutLeafCluster(node, direction, kindOf, edges, spacing, isRoot, previousPositions);
  }

  // 1. Lay out child clusters first (bottom-up).
  const childLayouts = new Map<string, ClusterLayout>();
  for (const key of childKeys) {
    const child = node.children.get(key)!;
    childLayouts.set(
      child.id,
      layoutCluster(
        child,
        depth + 1,
        direction,
        ancestry,
        kindOf,
        edges,
        spacing,
        previousPositions,
      ),
    );
  }

  // 2. Items = child clusters (box sizes) + direct nodes (node sizes).
  type LItem = Item & { child?: ClusterTreeNode };
  const items: LItem[] = [];
  for (const key of childKeys) {
    const child = node.children.get(key)!;
    const cl = childLayouts.get(child.id)!;
    items.push({ id: child.id, width: cl.width, height: cl.height, child });
  }
  for (const id of [...node.nodeIds].sort()) {
    const size = nodeSize(kindOf.get(id) ?? "");
    items.push({ id, width: size.width, height: size.height });
  }

  // 3. Collapse underlying edges to item-level edges within this cluster, summing weight +
  // count so the container planner and weighted dagre see real relationship strength (not a
  // flattened "there is some connection") between subsystem boxes.
  const itemEdges = new Map<string, ItemEdge>();
  for (const e of edges) {
    const su = itemOf(node.id, e.source, ancestry);
    const sv = itemOf(node.id, e.target, ancestry);
    if (su == null || sv == null || su === sv) continue;
    const key = edgeKey(su, sv);
    const cur = itemEdges.get(key);
    if (cur) {
      cur.weight += e.weight ?? 0;
      cur.count += e.count ?? 1;
    } else {
      itemEdges.set(key, { source: su, target: sv, weight: e.weight ?? 0, count: e.count ?? 1 });
    }
  }

  // Sort item-edges so layout is invariant to input edge order (dagre/Tarjan can
  // otherwise depend on insertion order).
  const sortedEdges = [...itemEdges.values()].sort(bySourceTarget);

  // Pick the container's box arrangement from the item-graph's SHAPE (same planner the leaves
  // use), not a two-rule heuristic — so subsystem boxes get layered/force/ring/grid as fits.
  const placement = containerPlacement(
    chooseEngine(
      graphShape(
        items.map((it) => it.id),
        sortedEdges,
      ),
    ),
  );

  // 4. Collapse cyclic items (SCCs) into ring super-items, lay out the acyclic
  // condensation with an adaptively chosen mode, then expand the rings.
  const sizeOf = new Map(items.map((it) => [it.id, { width: it.width, height: it.height }]));
  const comps = stronglyConnectedComponents(
    items.map((it) => it.id),
    sortedEdges,
  );
  const memberToSuper = new Map<string, string>();
  const superRing = new Map<string, { centers: Centers; cx: number; cy: number }>();
  const condItems: Item[] = [];
  for (const comp of comps) {
    if (comp.members.length === 1) {
      const s = sizeOf.get(comp.members[0])!;
      condItems.push({ id: comp.members[0], width: s.width, height: s.height });
      continue;
    }
    const memberItems: Item[] = comp.members.map((id) => ({ id, ...sizeOf.get(id)! }));
    const ring = circularItems(memberItems, spacing);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const mi of memberItems) {
      const c = ring.get(mi.id)!;
      minX = Math.min(minX, c.x - mi.width / 2);
      minY = Math.min(minY, c.y - mi.height / 2);
      maxX = Math.max(maxX, c.x + mi.width / 2);
      maxY = Math.max(maxY, c.y + mi.height / 2);
    }
    superRing.set(comp.id, { centers: ring, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
    for (const m of comp.members) memberToSuper.set(m, comp.id);
    condItems.push({ id: comp.id, width: maxX - minX, height: maxY - minY });
  }

  // Condensation edges: remap endpoints to their super-item, summing weight + count, sort.
  const condEdgeMap = new Map<string, ItemEdge>();
  for (const e of sortedEdges) {
    const s = memberToSuper.get(e.source) ?? e.source;
    const t = memberToSuper.get(e.target) ?? e.target;
    if (s === t) continue;
    const key = edgeKey(s, t);
    const cur = condEdgeMap.get(key);
    if (cur) {
      cur.weight += e.weight;
      cur.count += e.count;
    } else {
      condEdgeMap.set(key, { source: s, target: t, weight: e.weight, count: e.count });
    }
  }
  const condEdges = [...condEdgeMap.values()].sort(bySourceTarget);

  const condCenters =
    placement === "grid"
      ? gridItems(condItems, spacing)
      : placement === "force"
        ? forceItems(condItems, condEdges, spacing)
        : placement === "circular"
          ? circularItems(condItems, spacing)
          : dagreItems(condItems, condEdges, direction, spacing);

  // Expand super-items: each original item id → world-ish center (cluster-local).
  const centers: Centers = new Map();
  for (const ci of condItems) {
    const cc = condCenters.get(ci.id) ?? { x: 0, y: 0 };
    const ring = superRing.get(ci.id);
    if (ring) {
      for (const [mid, mc] of ring.centers) {
        centers.set(mid, { x: cc.x + (mc.x - ring.cx), y: cc.y + (mc.y - ring.cy) });
      }
    } else {
      centers.set(ci.id, cc);
    }
  }

  // 5. Convert to top-lefts; place direct nodes; offset child contents.
  const positions = new Map<string, XYPosition>();
  const clusters: ClusterBox[] = [];
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const it of items) {
    const c = centers.get(it.id) ?? { x: 0, y: 0 };
    const tlx = c.x - it.width / 2;
    const tly = c.y - it.height / 2;
    placed.push({ x: tlx, y: tly, w: it.width, h: it.height });
    if (it.child) {
      const cl = childLayouts.get(it.id)!;
      clusters.push({
        id: it.id,
        parentId: isRoot ? undefined : node.id,
        x: tlx,
        y: tly,
        width: it.width,
        height: it.height,
        depth: depth + 1,
        label: it.child.label,
        // Only leaf children carry these (the planner ran inside them); containers don't.
        engine: cl.engine,
        requestedEngine: cl.requestedEngine,
        fallbackReason: cl.fallbackReason,
      });
      for (const [nid, p] of cl.positions) positions.set(nid, { x: p.x + tlx, y: p.y + tly });
      for (const b of cl.clusters) clusters.push({ ...b, x: b.x + tlx, y: b.y + tly });
    } else {
      positions.set(it.id, { x: tlx, y: tly });
    }
  }
  if (placed.length === 0) return { width: 0, height: 0, positions, clusters };

  // 6. Normalize to the cluster's inset origin and compute the box size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const dx = (isRoot ? 0 : pad) - minX;
  const dy = (isRoot ? 0 : pad + HEADER_H) - minY;
  for (const [nid, p] of positions) positions.set(nid, { x: p.x + dx, y: p.y + dy });
  for (const b of clusters) {
    b.x += dx;
    b.y += dy;
  }
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  return {
    width: isRoot ? contentW : contentW + 2 * pad,
    height: isRoot ? contentH : contentH + 2 * pad + HEADER_H,
    positions,
    clusters,
  };
}

/** Smart (semanticMultilevel) layout: group by directory / community / none, lay out by dependency flow. */
export function smartLayout(
  view: LayoutInput,
  options: {
    direction?: LayoutDirection;
    groupBy?: GroupBy;
    density?: number;
    communityOf?: Map<string, string>;
    previousPositions?: Map<string, XYPosition>;
  } = {},
): LayoutResult {
  const direction = options.direction ?? "TB";
  const groupBy = options.groupBy ?? "directory";
  const spacing = options.density ?? 1;

  let groupOf: ((node: { id: string; kind: string }) => string[]) | undefined;
  if (groupBy === "community") {
    // Prefer the injected map (shared with the collapse transform) so rendered
    // boxes and collapse targets stay consistent; else detect on the view.
    const community =
      options.communityOf ??
      detectCommunities(
        view.nodes.map((n) => n.id),
        view.edges,
      );
    // Size communities over VIEW nodes only — the injected map may carry ids that
    // aren't in the view (symbols, or nodes collapsed away).
    const sizes = new Map<string, number>();
    for (const n of view.nodes) {
      const c = community.get(n.id);
      if (c) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    }
    groupOf = (n) => {
      const c = community.get(n.id);
      // Leave singleton communities at the root — avoids a sea of one-node boxes.
      return c && (sizes.get(c) ?? 0) > 1 ? [c] : [];
    };
  } else if (groupBy === "none") {
    groupOf = () => []; // everything at the root — no containers
  }
  // "directory" leaves groupOf undefined → buildClusterTree's default dir logic.

  const { root, ancestry } = buildClusterTree(view.nodes, groupOf);
  const kindOf = new Map(view.nodes.map((n) => [n.id, n.kind]));
  const out = layoutCluster(
    root,
    -1,
    direction,
    ancestry,
    kindOf,
    view.edges,
    spacing,
    options.previousPositions,
  );
  return { nodes: out.positions, clusters: out.clusters };
}
