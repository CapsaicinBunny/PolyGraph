import dagre from "@dagrejs/dagre";
import {
  type ClusterBox,
  type LayoutDirection,
  type LayoutInput,
  type LayoutResult,
  nodeSize,
  type XYPosition,
} from "../layout";
import { buildClusterTree, type ClusterTreeNode } from "./clusters";

const PADDING = 24;
const HEADER_H = 26;

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
  type Item = { id: string; width: number; height: number; child?: ClusterTreeNode };
  const items: Item[] = [];
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

  // 4. Place items.
  const centers = dagreItems(items, [...itemEdges.values()], direction);

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

/** Smart (semanticMultilevel) layout: group by nested directory, lay out by dependency flow. */
export function smartLayout(
  view: LayoutInput,
  options: { direction?: LayoutDirection } = {},
): LayoutResult {
  const direction = options.direction ?? "TB";
  const { root, ancestry } = buildClusterTree(view.nodes);
  const kindOf = new Map(view.nodes.map((n) => [n.id, n.kind]));
  const out = layoutCluster(root, -1, direction, ancestry, kindOf, view.edges);
  return { nodes: out.positions, clusters: out.clusters };
}
