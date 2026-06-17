// The directory hierarchy of a graph — the backbone of adaptive level-of-detail
// ("Nanite for graphs", see docs/SCALE-100K.md). A code graph is a tree of
// directories; every v1 LOD strategy needs to know that tree, the file count in
// each subtree (the "weight" that drives how much screen area / detail a cluster
// deserves), and the cluster ids that match collapseClusters' keys.
//
// Pure and O(N): one pass over the file nodes builds the whole tree.

import type { GraphModel } from "./types";

export interface DirNode {
  /** Directory path, "/"-joined, e.g. "drivers/net". "" for the synthetic root. */
  path: string;
  /** Last path segment, e.g. "net". "" for the root. */
  name: string;
  /** Depth from the root: top-level dirs are depth 1, the root is depth 0. */
  depth: number;
  /** Child directories, sorted by descending subtree file count then name. */
  children: DirNode[];
  /** File node ids directly in this directory (not in any subdirectory). */
  files: string[];
  /** Total file nodes in this directory's whole subtree (self + descendants). */
  totalFiles: number;
}

/** Directory path of a file node's path: "drivers/net/x.c" → "drivers/net" (""=root). */
export function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

function makeNode(path: string, depth: number): DirNode {
  const name = path === "" ? "" : path.slice(path.lastIndexOf("/") + 1);
  return { path, name, depth, children: [], files: [], totalFiles: 0 };
}

/**
 * Build the directory tree over the graph's file nodes. Returns the synthetic
 * root (path ""), whose children are the top-level directories. `totalFiles` is
 * filled in for every node; children are sorted heaviest-first (stable, by name
 * on ties) so callers can prioritize the busiest directories.
 */
export function buildDirTree(graph: GraphModel): DirNode {
  const root = makeNode("", 0);
  const byPath = new Map<string, DirNode>([["", root]]);

  const ensure = (path: string): DirNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const parent = ensure(parentPath);
    const node = makeNode(path, parent.depth + 1);
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const dir = ensure(dirOf(n.filePath));
    dir.files.push(n.id);
  }

  // Roll subtree file counts up from the leaves (iterative post-order over the
  // map, so deep trees can't overflow the stack).
  const order: DirNode[] = [];
  const stack: DirNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const c of node.children) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    node.totalFiles = node.files.length;
    for (const c of node.children) node.totalFiles += c.totalFiles;
    node.children.sort((a, b) => b.totalFiles - a.totalFiles || a.name.localeCompare(b.name));
  }

  return root;
}

/** Flatten a dir tree to a map path → node (excluding the synthetic root). */
export function dirIndex(root: DirNode): Map<string, DirNode> {
  const index = new Map<string, DirNode>();
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    index.set(node.path, node);
    for (const c of node.children) stack.push(c);
  }
  return index;
}
