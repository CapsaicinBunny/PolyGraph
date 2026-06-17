// Pure graph-traversal queries over a GraphModel — the language-agnostic core for
// focus / impact-analysis. Everything returns node ids (or paths) so any UI can
// render the result as a focused subgraph.

import { topFolderOf } from "./filters";
import type { EdgeKind, GraphModel } from "./types";

interface Adjacency {
  out: Map<string, { id: string; kind: EdgeKind }[]>;
  inc: Map<string, { id: string; kind: EdgeKind }[]>;
}

/** Build directed out/in adjacency once. Unknown endpoints are ignored. */
export function buildAdjacency(graph: GraphModel): Adjacency {
  const out = new Map<string, { id: string; kind: EdgeKind }[]>();
  const inc = new Map<string, { id: string; kind: EdgeKind }[]>();
  for (const n of graph.nodes) {
    out.set(n.id, []);
    inc.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (out.has(e.source) && inc.has(e.target)) {
      out.get(e.source)!.push({ id: e.target, kind: e.kind });
      inc.get(e.target)!.push({ id: e.source, kind: e.kind });
    }
  }
  return { out, inc };
}

/** BFS from `start` over the given side, to `maxDepth` hops. Excludes `start`. */
function reach(
  adj: Map<string, { id: string; kind: EdgeKind }[]>,
  start: string,
  maxDepth: number,
): Set<string> {
  const seen = new Set<string>([start]);
  const result = new Set<string>();
  let frontier = [start];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { id: nb } of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          result.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return result;
}

/** Everything `id` (transitively) relies on — forward over outgoing edges. */
export function dependencies(graph: GraphModel, id: string, maxDepth = Infinity): Set<string> {
  return reach(buildAdjacency(graph).out, id, maxDepth);
}

/** Everything (transitively) affected by changing `id` — reverse over incoming edges. */
export function dependents(graph: GraphModel, id: string, maxDepth = Infinity): Set<string> {
  return reach(buildAdjacency(graph).inc, id, maxDepth);
}

/** Nodes within `depth` undirected hops of `id`, including `id` itself. */
export function neighborhood(graph: GraphModel, id: string, depth: number): Set<string> {
  const { out, inc } = buildAdjacency(graph);
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const { id: nb } of [...(out.get(cur) ?? []), ...(inc.get(cur) ?? [])]) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Shortest directed path `from`→`to` (inclusive), or null if unreachable. */
export function shortestPath(graph: GraphModel, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const { out } = buildAdjacency(graph);
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const { id: nb } of out.get(cur) ?? []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === to) {
        const path = [to];
        let p = to;
        while (prev.has(p)) {
          p = prev.get(p) as string;
          path.push(p);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

export interface Connection {
  path: string[];
  edges: { source: string; target: string; kind: EdgeKind }[];
}

/** Explain how `from` connects to `to`: the shortest path plus the connecting edges. */
export function whyConnected(graph: GraphModel, from: string, to: string): Connection | null {
  const path = shortestPath(graph, from, to);
  if (!path || path.length < 2) return path ? { path, edges: [] } : null;
  const { out } = buildAdjacency(graph);
  const edges: { source: string; target: string; kind: EdgeKind }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const link = (out.get(a) ?? []).find((e) => e.id === b);
    if (link) edges.push({ source: a, target: b, kind: link.kind });
  }
  return { path, edges };
}

export interface BlastRadius {
  total: number;
  byPackage: Record<string, number>;
  byFile: Record<string, number>;
  byKind: Record<string, number>;
}

/** The set of nodes affected by changing `id`, grouped by package, file, and relationship kind. */
export function blastRadius(graph: GraphModel, id: string): BlastRadius {
  const { inc } = buildAdjacency(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const affected = reach(inc, id, Infinity);

  const byPackage: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const nid of affected) {
    const node = nodeById.get(nid);
    if (!node) continue;
    const pkg = node.kind === "external" ? "«external»" : topFolderOf(node.filePath) || "/";
    byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
    byFile[node.parentFile] = (byFile[node.parentFile] ?? 0) + 1;
  }

  // Relationship breakdown: edges within the affected set (+ id) by kind.
  const byKind: Record<string, number> = {};
  const inSet = new Set([...affected, id]);
  for (const e of graph.edges) {
    if (inSet.has(e.source) && inSet.has(e.target)) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }

  return { total: affected.size, byPackage, byFile, byKind };
}
