import dagre from "@dagrejs/dagre";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import {
  type ClusterBox,
  type GroupBy,
  type LayoutDirection,
  type LayoutInput,
  type LayoutResult,
  nodeSize,
  type XYPosition,
} from "../layout";
import { buildClusterTree, type ClusterTreeNode } from "./clusters";
import { detectCommunities } from "./community";
import { stronglyConnectedComponents } from "./scc";

const PADDING = 24;
const HEADER_H = 26;

type Item = { id: string; width: number; height: number };
type Centers = Map<string, XYPosition>;

interface ClusterLayout {
  width: number;
  height: number;
  positions: Map<string, XYPosition>; // node top-lefts, local to this cluster's top-left
  clusters: ClusterBox[]; // descendant boxes, local to this cluster's top-left
}

/** The item (child cluster id, or the node id itself) that `nodeId` maps to within cluster `sx`. */
function itemOf(sx: string, nodeId: string, ancestry: Map<string, string[]>): string | null {
  const anc = ancestry.get(nodeId) ?? [];
  if (sx === "") return anc.length > 0 ? anc[0] : nodeId;
  const i = anc.indexOf(sx);
  if (i === -1) return null; // node is not inside this cluster
  return i + 1 < anc.length ? anc[i + 1] : nodeId;
}

/** Place sized items with dagre; returns item centers. */
function dagreItems(
  items: { id: string; width: number; height: number }[],
  edges: { source: string; target: string }[],
  direction: LayoutDirection,
): Map<string, XYPosition> {
  const centers = new Map<string, XYPosition>();
  if (items.length === 0) return centers;
  const vertical = direction === "TB" || direction === "BT";
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: vertical ? 36 : 24,
    ranksep: vertical ? 70 : 90,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const it of items) g.setNode(it.id, { width: it.width, height: it.height });
  for (const e of edges) {
    if (e.source !== e.target && g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target);
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
function gridItems(items: Item[]): Centers {
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
  const stepX = cellW + 40;
  const stepY = cellH + 40;
  items.forEach((it, i) => {
    centers.set(it.id, { x: (i % cols) * stepX, y: Math.floor(i / cols) * stepY });
  });
  return centers;
}

/** Items evenly spaced on a ring around the origin (centers). Used inside SCC super-items. */
function circularItems(items: Item[]): Centers {
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
  const radius = Math.max(160, (n * (extent + 30)) / (2 * Math.PI));
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
function forceItems(items: Item[], edges: { source: string; target: string }[]): Centers {
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
        .distance(radius * 2.2)
        .strength(0.4),
    )
    .force("center", forceCenter(0, 0))
    .force("collide", forceCollide(radius))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();
  items.forEach((it, i) => centers.set(it.id, { x: simNodes[i].x ?? 0, y: simNodes[i].y ?? 0 }));
  return centers;
}

type Mode = "grid" | "force" | "layered";

/** Pick a cluster's internal layout from its (acyclic) item-graph shape. */
function chooseMode(n: number, m: number): Mode {
  if (m === 0) return "grid"; // nothing connects — tile tidily
  if (m > n * 1.6) return "force"; // dense/tangled — dagre would sprawl
  return "layered"; // a clean DAG — dagre ranks it well
}

function layoutCluster(
  node: ClusterTreeNode,
  depth: number,
  direction: LayoutDirection,
  ancestry: Map<string, string[]>,
  kindOf: Map<string, string>,
  edges: LayoutInput["edges"],
): ClusterLayout {
  const isRoot = node.id === "";
  const childKeys = [...node.children.keys()].sort();

  // 1. Lay out child clusters first (bottom-up).
  const childLayouts = new Map<string, ClusterLayout>();
  for (const key of childKeys) {
    const child = node.children.get(key)!;
    childLayouts.set(child.id, layoutCluster(child, depth + 1, direction, ancestry, kindOf, edges));
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

  // 3. Collapse underlying edges to item-level edges within this cluster.
  const itemEdges = new Map<string, { source: string; target: string }>();
  for (const e of edges) {
    const su = itemOf(node.id, e.source, ancestry);
    const sv = itemOf(node.id, e.target, ancestry);
    if (su == null || sv == null || su === sv) continue;
    itemEdges.set(`${su} ${sv}`, { source: su, target: sv });
  }

  // Sort item-edges so layout is invariant to input edge order (dagre/Tarjan can
  // otherwise depend on insertion order).
  const cmpEdge = (a: { source: string; target: string }, b: { source: string; target: string }) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.target < b.target
          ? -1
          : a.target > b.target
            ? 1
            : 0;
  const sortedEdges = [...itemEdges.values()].sort(cmpEdge);

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
    const ring = circularItems(memberItems);
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

  // Condensation edges: remap endpoints to their super-item, drop self/dups, sort.
  const condEdgeMap = new Map<string, { source: string; target: string }>();
  for (const e of sortedEdges) {
    const s = memberToSuper.get(e.source) ?? e.source;
    const t = memberToSuper.get(e.target) ?? e.target;
    if (s === t) continue;
    condEdgeMap.set(`${s} ${t}`, { source: s, target: t });
  }
  const condEdges = [...condEdgeMap.values()].sort(cmpEdge);

  const mode = chooseMode(condItems.length, condEdges.length);
  const condCenters =
    mode === "grid"
      ? gridItems(condItems)
      : mode === "force"
        ? forceItems(condItems, condEdges)
        : dagreItems(condItems, condEdges, direction);

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
  const dx = (isRoot ? 0 : PADDING) - minX;
  const dy = (isRoot ? 0 : PADDING + HEADER_H) - minY;
  for (const [nid, p] of positions) positions.set(nid, { x: p.x + dx, y: p.y + dy });
  for (const b of clusters) {
    b.x += dx;
    b.y += dy;
  }
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  return {
    width: isRoot ? contentW : contentW + 2 * PADDING,
    height: isRoot ? contentH : contentH + 2 * PADDING + HEADER_H,
    positions,
    clusters,
  };
}

/** Smart (semanticMultilevel) layout: group by directory / community / none, lay out by dependency flow. */
export function smartLayout(
  view: LayoutInput,
  options: { direction?: LayoutDirection; groupBy?: GroupBy } = {},
): LayoutResult {
  const direction = options.direction ?? "TB";
  const groupBy = options.groupBy ?? "directory";

  let groupOf: ((node: { id: string; kind: string }) => string[]) | undefined;
  if (groupBy === "community") {
    const community = detectCommunities(
      view.nodes.map((n) => n.id),
      view.edges,
    );
    const sizes = new Map<string, number>();
    for (const c of community.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
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
  const out = layoutCluster(root, -1, direction, ancestry, kindOf, view.edges);
  return { nodes: out.positions, clusters: out.clusters };
}
