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
export function buildClusterTree(nodes: LayoutInput["nodes"]): {
  root: ClusterTreeNode;
  ancestry: Map<string, string[]>;
} {
  const root: ClusterTreeNode = { id: "", label: "", children: new Map(), nodeIds: [] };
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of sorted) {
    let cur = root;
    let path = "";
    for (const seg of dirSegments(n)) {
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
