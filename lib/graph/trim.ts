// Payload guard for very large scans. Each edge can carry up to OCCURRENCE_CAP
// (25) evidence occurrences, and on a 100k-node repo (hundreds of thousands of
// edges) those occurrences are the bulk of the serialized graph — enough that
// JSON.stringify of the scan response can approach V8's ~512MB string ceiling and
// hard-fail. When the graph is huge we trim occurrences to a small sample,
// keeping `count` (the exact total) intact, so the UI still shows "N occurrences"
// and edge thickness is unchanged — only the per-occurrence detail is reduced.
// Pure; below the threshold the graph is returned untouched.

import type { GraphModel } from "./types";

/** Above this many nodes, trim edge occurrences to bound the response size. */
export const OCCURRENCE_TRIM_NODES = 20000;
/** Occurrences kept per edge once trimming is active. */
export const TRIMMED_OCCURRENCES = 1;

/** Slice every edge's occurrences to `maxPerEdge`, preserving `count`. */
export function trimEdgeOccurrences(graph: GraphModel, maxPerEdge: number): GraphModel {
  let changed = false;
  const edges = graph.edges.map((e) => {
    if (e.occurrences.length <= maxPerEdge) return e;
    changed = true;
    return { ...e, occurrences: e.occurrences.slice(0, maxPerEdge) };
  });
  return changed ? { nodes: graph.nodes, edges } : graph;
}

/**
 * Trim occurrences only when the graph is large enough to risk an oversized
 * response. Returns the graph unchanged otherwise (identity, no copy).
 */
export function trimIfLarge(
  graph: GraphModel,
  nodeThreshold = OCCURRENCE_TRIM_NODES,
  maxPerEdge = TRIMMED_OCCURRENCES,
): GraphModel {
  if (graph.nodes.length <= nodeThreshold) return graph;
  return trimEdgeOccurrences(graph, maxPerEdge);
}
