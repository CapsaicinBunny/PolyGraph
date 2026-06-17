// Adaptive level-of-detail: when a graph has too many file nodes to render, pick
// a directory depth to collapse so the scene shows a few hundred aggregate cards
// instead of 100k. This is the v0 (static, single-level) form of the Nanite-style
// per-view cut; the user can still expand any aggregate (the seeded set just
// becomes the initial collapsed state). Pure — see docs/SCALE-100K.md.

import { dirPrefixes } from "./collapse";
import type { GraphModel } from "./types";

export interface AutoCollapse {
  /** Directory depth chosen (1 = top-level dirs). */
  depth: number;
  /** Directory paths to collapse — the exact keys collapseClusters expects. */
  collapsed: Set<string>;
  /** Estimated rendered card count after collapsing (cards + un-absorbed files). */
  renderedEstimate: number;
}

/**
 * Choose directories to collapse so the rendered file-card count stays at or below
 * `maxCards`. Returns null when the graph already fits (no collapse needed).
 *
 * Collapsing every directory at depth `d` turns each into one aggregate card, so
 * rendered(d) = (#dirs at depth d) + (#files shallower than d) — which increases
 * monotonically with d. We pick the *deepest* d that still fits, for maximum
 * structure under the budget; if even depth 1 overflows (a very wide root) we use
 * depth 1 as the coarsest possible.
 */
export function autoCollapseDirs(graph: GraphModel, maxCards: number): AutoCollapse | null {
  const files = graph.nodes.filter((n) => n.kind === "file");
  if (files.length <= maxCards) return null;

  const dirsAtDepth = new Map<number, Set<string>>();
  // filesDeepEnough[d] = number of files whose directory depth is >= d (i.e. files
  // that a depth-d collapse would absorb).
  const filesDeepEnough = new Map<number, number>();
  let maxDepth = 0;

  for (const n of files) {
    const prefixes = dirPrefixes(n);
    maxDepth = Math.max(maxDepth, prefixes.length);
    prefixes.forEach((path, i) => {
      const d = i + 1;
      let set = dirsAtDepth.get(d);
      if (!set) {
        set = new Set();
        dirsAtDepth.set(d, set);
      }
      set.add(path);
      filesDeepEnough.set(d, (filesDeepEnough.get(d) ?? 0) + 1);
    });
  }

  const total = files.length;
  const rendered = (d: number): number => {
    const dirs = dirsAtDepth.get(d)?.size ?? 0;
    const absorbed = filesDeepEnough.get(d) ?? 0;
    return dirs + (total - absorbed);
  };

  let chosen = 0;
  for (let d = 1; d <= maxDepth; d++) {
    if (rendered(d) <= maxCards) chosen = d;
    else break; // rendered(d) is monotonic increasing — no deeper depth can fit
  }
  if (chosen === 0) chosen = 1; // even top-level overflows; coarsest we can do

  return {
    depth: chosen,
    collapsed: dirsAtDepth.get(chosen) ?? new Set(),
    renderedEstimate: rendered(chosen),
  };
}
