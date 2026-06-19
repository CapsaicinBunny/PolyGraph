// Tree engine helpers: extract a spanning arborescence (a real tree) from a
// general dependency graph, and score how tree-like a graph is. Placement itself
// uses d3-hierarchy's Buchheim tidy-tree (see treeLayout in lib/layout.ts). Pure
// and deterministic (sorted iteration, stable tie-breaks, no RNG).

interface WeightedEdge {
  source: string;
  target: string;
  weight?: number;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Arborescence {
  /** Tree parent of each node; null for roots. */
  parent: Map<string, string | null>;
  /** Root node ids (in stable order). */
  roots: string[];
}

/**
 * Build a spanning arborescence: each non-root node's parent is its
 * maximum-weight incoming edge from a node strictly closer to a root (so the
 * strongest architectural relationship becomes the tree edge and the result is
 * acyclic). Roots are sources (in-degree 0), or the highest-out-degree node when
 * the graph is fully cyclic. Non-tree edges are left for the caller to draw as
 * secondary cross-links.
 */
export function buildArborescence(nodeIds: string[], edges: WeightedEdge[]): Arborescence {
  const incoming = new Map<string, { from: string; weight: number }[]>();
  const out = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    out.set(id, []);
    indegree.set(id, 0);
  }
  for (const e of edges) {
    if (!incoming.has(e.source) || !incoming.has(e.target) || e.source === e.target) continue;
    incoming.get(e.target)!.push({ from: e.source, weight: e.weight ?? 1 });
    out.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  let roots = [...nodeIds].filter((id) => (indegree.get(id) ?? 0) === 0).sort(byId);
  if (roots.length === 0 && nodeIds.length > 0) {
    roots = [
      [...nodeIds]
        .sort(byId)
        .reduce((best, id) => (out.get(id)!.length > out.get(best)!.length ? id : best)),
    ];
  }

  // Directed BFS depth from the roots (over outgoing edges).
  const depth = new Map<string, number>();
  const queue = [...roots];
  for (const r of roots) depth.set(r, 0);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    const d = depth.get(v)!;
    for (const w of out.get(v) ?? []) {
      if (!depth.has(w)) {
        depth.set(w, d + 1);
        queue.push(w);
      }
    }
  }

  const parent = new Map<string, string | null>();
  for (const r of roots) parent.set(r, null);
  for (const v of [...nodeIds].sort(byId)) {
    if (parent.has(v)) continue;
    const dv = depth.get(v);
    if (dv === undefined) {
      // Not reachable from any root (a detached cycle); attach to a root as a sibling.
      parent.set(v, roots[0] ?? null);
      continue;
    }
    let best: { from: string; weight: number } | null = null;
    const pick = (eligible: (from: string) => boolean) => {
      for (const c of incoming.get(v)!) {
        if (!eligible(c.from)) continue;
        if (!best || c.weight > best.weight || (c.weight === best.weight && c.from < best.from)) {
          best = c;
        }
      }
    };
    pick((from) => depth.get(from) === dv - 1);
    if (!best) pick((from) => (depth.get(from) ?? Number.POSITIVE_INFINITY) < dv);
    parent.set(v, best ? (best as { from: string }).from : (roots[0] ?? null));
  }
  return { parent, roots };
}

/**
 * How tree-like a graph is, in [0, 1]: blends the single-parent ratio (a tree has
 * every non-root node with in-degree ≤ 1) with edge-count closeness to n-1. 1 for
 * a forest/tree; lower as merges and extra edges accumulate. Used by Smart to
 * decide when the tidy-tree engine is appropriate.
 */
export function treeScore(nodeIds: string[], edges: WeightedEdge[]): number {
  const n = nodeIds.length;
  if (n <= 1) return 1;
  const ids = new Set(nodeIds);
  const indegree = new Map<string, number>();
  let m = 0;
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    m += 1;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  let singleParent = 0;
  for (const id of nodeIds) if ((indegree.get(id) ?? 0) <= 1) singleParent += 1;
  const singleParentRatio = singleParent / n;
  const edgeCloseness = Math.max(0, 1 - Math.abs(m - (n - 1)) / n);
  return 0.6 * singleParentRatio + 0.4 * edgeCloseness;
}
