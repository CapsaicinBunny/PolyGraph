// Edge weighting for graph-aware layout. A typed dependency edge's pull on the
// layout is its relationship weight scaled by log2(1 + count): strong
// architectural relationships (inheritance, injection) outrank incidental ones
// (calls), and the log keeps thousands of repeated calls from burying a single
// `extends`. Used by the weighted layered/ordering passes; see docs/SCALE notes.

import type { ViewEdgeKind } from "../aggregate";

/** Base pull per relationship kind. "contains" is structural nesting → no pull. */
const RELATIONSHIP_WEIGHTS: Record<ViewEdgeKind, number> = {
  extends: 8,
  implements: 8,
  injects: 6,
  has: 5,
  import: 4,
  renders: 3,
  instantiates: 2,
  call: 1,
  contains: 0,
};

/** Base layout weight for a relationship kind (unknown kinds default to 1). */
export function relationshipWeight(kind: ViewEdgeKind): number {
  return RELATIONSHIP_WEIGHTS[kind] ?? 1;
}

/**
 * Layout weight of an edge: `relationshipWeight(kind) * log2(1 + count)`.
 * `count` is clamped at 0 so an absent/zero count yields 0 (never NaN/negative).
 */
export function edgeWeight(kind: ViewEdgeKind, count: number): number {
  return relationshipWeight(kind) * Math.log2(1 + Math.max(0, count));
}
