// Backbone (core-periphery) helpers. k-core decomposition finds the dense
// "backbone" of a graph; the layout (backboneLayout in lib/layout.ts) lays that
// out cleanly and hangs the low-coreness periphery (leaves/chains) off it, so a
// few thousand utility/test leaves can't blow the core apart. Pure, deterministic.

interface Edge {
  source: string;
  target: string;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * k-core decomposition: each node's coreness is the largest k for which it
 * survives in the k-core (repeatedly peel the lowest-degree nodes). Triangles and
 * denser structures get coreness ≥ 2; trees/leaves get 1; isolates 0. O(n+m)-ish,
 * deterministic (peels in id order).
 */
export function coreness(nodeIds: string[], edges: Edge[]): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of edges) {
    if (e.source === e.target || !adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  const degree = new Map<string, number>();
  for (const id of nodeIds) degree.set(id, adj.get(id)!.size);

  const core = new Map<string, number>();
  const remaining = new Set(nodeIds);
  let k = 0;
  while (remaining.size > 0) {
    let minDegree = Number.POSITIVE_INFINITY;
    for (const id of remaining) minDegree = Math.min(minDegree, degree.get(id)!);
    k = Math.max(k, minDegree);
    // Peel everything currently at degree ≤ k (repeat — peeling lowers neighbors).
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of [...remaining].sort(byId)) {
        if (degree.get(id)! <= k) {
          core.set(id, k);
          remaining.delete(id);
          for (const nb of adj.get(id)!) {
            if (remaining.has(nb)) degree.set(nb, degree.get(nb)! - 1);
          }
          peeled = true;
        }
      }
    }
  }
  return core;
}
