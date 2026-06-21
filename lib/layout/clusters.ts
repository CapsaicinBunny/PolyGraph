import {
  type CompactGroupingSnapshot,
  NO_GROUP,
} from "../graph/grouping-snapshot";
import type { LayoutInput } from "../layout";

/** A node in the directory cluster tree. `id` is "" for the root, else a full path like "src/lib/graph". */
export interface ClusterTreeNode {
  id: string;
  label: string;
  children: Map<string, ClusterTreeNode>;
  nodeIds: string[];
}

export const EXTERNAL_DIR = "«external»";

/** Directory segments a node belongs to (external nodes group under one synthetic dir). */
function dirSegments(node: { id: string; kind: string }): string[] {
  if (node.kind === "external") return [EXTERNAL_DIR];
  const hash = node.id.indexOf("#");
  const filePath = hash === -1 ? node.id : node.id.slice(0, hash);
  const parts = filePath.split("/");
  parts.pop(); // drop the filename — we group by directory
  return parts.filter((p) => p.length > 0);
}

/**
 * Build the nested directory cluster tree from layout nodes, plus a map from each
 * node id to the chain of cluster ids that contain it (outermost first, root excluded).
 * Deterministic: nodes are inserted in id order and children iterate by sorted key.
 */
export function buildClusterTree(
  nodes: LayoutInput["nodes"],
  groupOf: (node: { id: string; kind: string }) => string[] = dirSegments,
): {
  root: ClusterTreeNode;
  ancestry: Map<string, string[]>;
} {
  const root: ClusterTreeNode = { id: "", label: "", children: new Map(), nodeIds: [] };
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of sorted) {
    let cur = root;
    let path = "";
    for (const seg of groupOf(n)) {
      path = path ? `${path}/${seg}` : seg;
      let child = cur.children.get(seg);
      if (!child) {
        child = { id: path, label: seg, children: new Map(), nodeIds: [] };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.nodeIds.push(n.id);
  }
  compress(root, true);
  const ancestry = new Map<string, string[]>();
  collectAncestry(root, [], ancestry);
  return { root, ancestry };
}

/** Merge a cluster with its only child when it has no direct nodes (path compression). */
function compress(node: ClusterTreeNode, isRoot: boolean): void {
  for (const child of node.children.values()) compress(child, false);
  if (isRoot) return;
  while (node.children.size === 1 && node.nodeIds.length === 0) {
    const only = [...node.children.values()][0];
    node.id = only.id;
    node.label = `${node.label}/${only.label}`;
    node.nodeIds = only.nodeIds;
    node.children = only.children;
  }
}

/** Record, for every node id, the chain of cluster ids containing it (root excluded). */
function collectAncestry(node: ClusterTreeNode, path: string[], out: Map<string, string[]>): void {
  for (const id of node.nodeIds) out.set(id, [...path]);
  for (const key of [...node.children.keys()].sort()) {
    const child = node.children.get(key)!;
    collectAncestry(child, [...path, child.id], out);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster tree ⇄ CompactGroupingSnapshot (Phase C1a, spec "Phase plan → C1a").
//
// The layout input contract changes from "Smart derives the cluster tree from node
// ids internally" to "Smart consumes a CompactGroupingSnapshot". The snapshot is
// built ONCE on the main thread (from the post-filter/post-collapse layout nodes) and
// the typed arrays transfer to the worker, which rebuilds the SAME tree — so the
// worker no longer needs the node-path/dirSegments logic.
//
// `snapshotFromClusterTree` serializes an already-built (compressed) cluster tree into
// the snapshot; `buildClusterTreeFromSnapshot` reconstructs the identical tree. The
// round-trip is byte-identical (proven in clusters-snapshot.test.ts), so Directory
// layout output is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The child-map key the cluster tree uses for a box with id `childBoxKey` under a
 * parent with id `parentBoxKey`. Mirrors `buildClusterTree`, which keys each child by
 * the FIRST path segment under its parent (compression keeps that original key even
 * when the box id grows, e.g. box "src/lib/graph" stays under key "src"). Flat
 * (no-"/") ids key by the whole id.
 */
function childKeyOf(parentBoxKey: string, childBoxKey: string): string {
  const rel =
    parentBoxKey !== "" && childBoxKey.startsWith(`${parentBoxKey}/`)
      ? childBoxKey.slice(parentBoxKey.length + 1)
      : childBoxKey;
  const slash = rel.indexOf("/");
  return slash === -1 ? rel : rel.slice(0, slash);
}

/**
 * Serialize a built (compressed) cluster tree into a CompactGroupingSnapshot. Each
 * box becomes a group (boxKey = box id, label = box label, parent links from the tree).
 * `directGroupByNode[i]` is the group ordinal of the box directly containing layout
 * node `nodes[i]` — its ancestry's last box — or NO_GROUP for a root-level node.
 * Group ordinals are assigned by a deterministic pre-order walk (children sorted by
 * map key), so the snapshot is canonical.
 */
export function snapshotFromClusterTree(
  built: { root: ClusterTreeNode; ancestry: Map<string, string[]> },
  nodes: LayoutInput["nodes"],
  modeKey: string,
): CompactGroupingSnapshot {
  const groupIds: string[] = [];
  const groupLabels: string[] = [];
  const boxKeyByGroup: string[] = [];
  const parents: number[] = [];
  const depths: number[] = [];
  const rootOrdinals: number[] = [];
  // box id → group ordinal (also the directGroupByNode lookup, via the node's ancestry tail).
  const ordinalOf = new Map<string, number>();

  const walk = (node: ClusterTreeNode, parent: number, depth: number) => {
    for (const key of [...node.children.keys()].sort()) {
      const child = node.children.get(key)!;
      const ordinal = groupIds.length;
      ordinalOf.set(child.id, ordinal);
      groupIds.push(child.id); // namespaced id == box id (boxKey) in C1a
      groupLabels.push(child.label);
      boxKeyByGroup.push(child.id);
      parents.push(parent);
      depths.push(depth);
      if (parent === -1) rootOrdinals.push(ordinal);
      walk(child, ordinal, depth + 1);
    }
  };
  walk(built.root, -1, 0);

  const directGroupByNode = new Uint32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const anc = built.ancestry.get(nodes[i].id);
    const boxId = anc && anc.length > 0 ? anc[anc.length - 1] : undefined;
    const ord = boxId !== undefined ? ordinalOf.get(boxId) : undefined;
    directGroupByNode[i] = ord ?? NO_GROUP;
  }

  return {
    modeKey,
    groupIds,
    groupLabels,
    parentByGroup: Int32Array.from(parents),
    depthByGroup: Uint16Array.from(depths),
    boxKeyByGroup,
    directGroupByNode,
    roots: Uint32Array.from(rootOrdinals),
  };
}

/**
 * Reconstruct the cluster tree `{root, ancestry}` from a CompactGroupingSnapshot and
 * the layout nodes. The snapshot's groups are already the final (compressed) boxes, so
 * NO further compression runs — the tree is rebuilt directly: one ClusterTreeNode per
 * group (id = boxKey, label), nested by `parentByGroup`, with each layout node placed
 * in its `directGroupByNode` box (NO_GROUP → the root). Children keep the same map keys
 * `buildClusterTree` used (first segment under the parent), so iteration order — and
 * thus layout output — matches byte-for-byte. `ancestry` is rebuilt by walking
 * `parentByGroup`.
 */
export function buildClusterTreeFromSnapshot(
  nodes: LayoutInput["nodes"],
  snapshot: CompactGroupingSnapshot,
): { root: ClusterTreeNode; ancestry: Map<string, string[]> } {
  const root: ClusterTreeNode = { id: "", label: "", children: new Map(), nodeIds: [] };
  const { groupIds, groupLabels, boxKeyByGroup, parentByGroup } = snapshot;
  const n = groupIds.length;

  // Materialize a ClusterTreeNode per group.
  const treeNodes: ClusterTreeNode[] = new Array(n);
  for (let g = 0; g < n; g++) {
    treeNodes[g] = { id: boxKeyByGroup[g], label: groupLabels[g], children: new Map(), nodeIds: [] };
  }
  // Link children under their parent using the buildClusterTree map key.
  for (let g = 0; g < n; g++) {
    const parent = parentByGroup[g];
    const parentNode = parent === -1 ? root : treeNodes[parent];
    const key = childKeyOf(parentNode.id, boxKeyByGroup[g]);
    parentNode.children.set(key, treeNodes[g]);
  }

  // Place each layout node into its direct box (sorted within the box, as
  // buildClusterTree's global id-sort yields). Carry the original index so the
  // directGroupByNode lookup stays O(1) (no indexOf scan).
  const order = nodes.map((nd, i) => ({ id: nd.id, i }));
  order.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { id, i } of order) {
    const g = snapshot.directGroupByNode[i];
    (g === NO_GROUP ? root : treeNodes[g]).nodeIds.push(id);
  }

  const ancestry = new Map<string, string[]>();
  collectAncestry(root, [], ancestry);
  return { root, ancestry };
}
