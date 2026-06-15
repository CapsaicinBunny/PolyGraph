import type { EdgeKind, GraphModel, GraphNode } from "./graph/types";

export type ViewEdgeKind = EdgeKind | "contains";

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: ViewEdgeKind;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: ViewEdge[];
}

/**
 * Project the full symbol-level graph into a displayable view given the set of
 * expanded file ids.
 *
 * - File nodes are always shown.
 * - A file's symbol nodes are shown only when that file is expanded; a dashed
 *   "contains" edge attaches each symbol to its file.
 * - An edge endpoint inside a collapsed file is remapped to the file node, so a
 *   call between two collapsed files appears as a file-to-file edge.
 */
export function buildView(graph: GraphModel, expanded: Set<string>): GraphView {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const visibleNodes = graph.nodes.filter((n) => n.kind === "file" || expanded.has(n.parentFile));

  // Map any node id to the id that represents it in the current view.
  const repr = (id: string): string | undefined => {
    const node = nodeById.get(id);
    if (!node) return undefined;
    if (node.kind === "file") return node.id;
    return expanded.has(node.parentFile) ? node.id : node.parentFile;
  };

  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  const push = (source: string, target: string, kind: ViewEdgeKind) => {
    if (source === target) return;
    const id = `${source}->${target}:${kind}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, source, target, kind });
  };

  for (const edge of graph.edges) {
    const s = repr(edge.source);
    const t = repr(edge.target);
    if (!s || !t) continue;
    push(s, t, edge.kind);
  }

  // Containment edges for expanded files.
  for (const node of visibleNodes) {
    if (node.kind !== "file" && expanded.has(node.parentFile)) {
      push(node.parentFile, node.id, "contains");
    }
  }

  return { nodes: visibleNodes, edges };
}

/** The fully collapsed file-level view — every file node, no symbols. */
export function fileLevelView(graph: GraphModel): GraphView {
  return buildView(graph, new Set<string>());
}

/** Count symbols owned by each file, for showing expand affordances. */
export function symbolCounts(graph: GraphModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === "file") continue;
    counts.set(node.parentFile, (counts.get(node.parentFile) ?? 0) + 1);
  }
  return counts;
}

export function isFileNode(node: GraphNode): boolean {
  return node.kind === "file";
}
