// The "Expand all" / "Collapse all" toolbar toggle, as a pure decision so the
// (subtle, regression-prone) interaction with Adaptive LOD is testable without a
// renderer.
//
// Three pieces of state move together:
//   - `expanded`          — which files are opened to show their symbols.
//   - `collapsedClusters` — which directory aggregates are folded into one card.
//   - Adaptive LOD        — the camera-driven cut that rewrites `collapsedClusters`
//                           on zoom to keep the visible card count bounded.
//
// Adaptive LOD ignores manual expansion, so with it on, zooming out immediately
// re-collapses a freshly expanded view (the reported regression). The toggle drives
// Adaptive LOD symmetrically so the two never fight: expanding is an explicit
// "show detail" intent, so it turns Adaptive LOD OFF; collapsing returns to the
// bounded overview, so it turns Adaptive LOD back ON (its default). Both directions
// reseed the cut to the auto-collapse frontier: expanding keeps a huge repo (the
// whole kernel is millions of nodes) within the renderer's budget instead of trying
// to draw everything, and collapsing returns to the initial scanned view (without
// the reseed, a stale cut left most nodes folded until a rescan).

export interface ExpandAllNext {
  expanded: Set<string>;
  collapsedClusters: Set<string>;
  /** Desired Adaptive LOD state after the toggle: off when expanding, on when collapsing. */
  adaptiveLod: boolean;
}

/**
 * Decide the next expand/collapse state. `seedCut` is the auto-collapse frontier
 * for the current graph (empty for repos small enough to draw whole).
 */
export function nextExpandAll(
  allExpanded: boolean,
  fileIds: readonly string[],
  seedCut: Set<string>,
): ExpandAllNext {
  if (allExpanded) {
    return { expanded: new Set(), collapsedClusters: seedCut, adaptiveLod: true };
  }
  return { expanded: new Set(fileIds), collapsedClusters: seedCut, adaptiveLod: false };
}
