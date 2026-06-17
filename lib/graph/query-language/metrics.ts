// Precomputed per-node metrics for query evaluation: degrees, call-out count, cycle
// membership, and a reverse-reachability helper for `depends-on`. Built once per query
// run so each predicate is cheap.

import { stronglyConnectedComponents } from "../../layout/scc";
import { buildAdjacency } from "../query";
import type { GraphModel } from "../types";

export interface MetricsIndex {
  readonly allIds: string[];
  inDegree(id: string): number;
  outDegree(id: string): number;
  /** Number of outgoing `call` edges. */
  callsOut(id: string): number;
  /** True when the node is in a strongly-connected component of size > 1. */
  inCycle(id: string): boolean;
  /** Node ids that can reach any node in `targets` (excluding the targets). */
  reverseReachable(targets: Set<string>): Set<string>;
}

export function buildMetrics(graph: GraphModel): MetricsIndex {
  const { out, inc } = buildAdjacency(graph);
  const callsOut = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind === "call") callsOut.set(e.source, (callsOut.get(e.source) ?? 0) + 1);
  }

  const cycleNodes = new Set<string>();
  for (const scc of stronglyConnectedComponents(
    graph.nodes.map((n) => n.id),
    graph.edges.map((e) => ({ source: e.source, target: e.target })),
  )) {
    if (scc.members.length > 1) for (const m of scc.members) cycleNodes.add(m);
  }

  const allIds = graph.nodes.map((n) => n.id);

  return {
    allIds,
    inDegree: (id) => inc.get(id)?.length ?? 0,
    outDegree: (id) => out.get(id)?.length ?? 0,
    callsOut: (id) => callsOut.get(id) ?? 0,
    inCycle: (id) => cycleNodes.has(id),
    reverseReachable(targets) {
      // Multi-source BFS backwards over incoming edges from every target at once.
      const seen = new Set<string>(targets);
      let frontier = [...targets];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const { id: pred } of inc.get(id) ?? []) {
            if (!seen.has(pred)) {
              seen.add(pred);
              next.push(pred);
            }
          }
        }
        frontier = next;
      }
      for (const t of targets) seen.delete(t);
      return seen;
    },
  };
}
