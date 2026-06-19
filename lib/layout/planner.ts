// The Smart planner: map a (sub)graph's shape to the layout engine that fits it.
// This replaces the old two-rule chooseMode (grid / force / layered by edge count)
// with shape-aware selection across the full upgraded engine set. Pure on the
// GraphShape, so deterministic.

import type { LayoutAlgorithm } from "../layout";
import type { GraphShape } from "./shape";

/** Largest cyclic component for which a single ring stays legible. */
const CIRCULAR_MAX = 60;
// Stress majorization is ~O(n²); only AUTO-select it where it finishes fast. Manual
// selection allows larger components (see HEAVY_COMPONENT_CAP.stress in layout.ts).
const STRESS_AUTO_MAX = 400;

/**
 * Choose the best concrete engine for a graph of the given shape. Order matters —
 * earlier, more specific rules win. Never returns "smart" (the planner is what
 * "smart" resolves to).
 */
export function chooseEngine(shape: GraphShape): LayoutAlgorithm {
  // Nothing connects → tidy table.
  if (shape.edgeCount === 0 || shape.isolateRatio > 0.9) return "grid";
  // A genuine rooted tree → tidy tree (needs a clear source to root at).
  if (shape.treeScore > 0.8 && shape.sourceRatio > 0) return "tree";
  // Mostly acyclic dependency flow → layered Sugiyama.
  if (shape.dagScore > 0.8) return "layered";
  // A small, mostly-cyclic component → a single ordered ring.
  if (shape.sccNodeRatio > 0.5 && shape.nodeCount <= CIRCULAR_MAX) return "circular";
  // A dense core with lots of leaves hanging off → backbone (core + satellites).
  // Either leaf-dominance over a cyclic core, or strong degree skew with real hubs
  // (a few nodes own most of the edges) — the latter uses degreeGini/hubRatio.
  if (
    (shape.leafRatio > 0.4 && shape.sccNodeRatio > 0.1) ||
    (shape.leafRatio > 0.3 && shape.hubRatio > 0.02 && shape.degreeGini > 0.45)
  )
    return "backbone";
  // Substantially cyclic and small enough that stress majorization stays fast → stress
  // untangles it best (and covers big rings too large for a single circle).
  if (shape.sccNodeRatio > 0.3 && shape.nodeCount <= STRESS_AUTO_MAX) return "stress";
  // Dense / large tangle → force (Barnes–Hut scales beyond stress's reach).
  if (shape.density > 0.15) return "force";
  // Mild cycles otherwise: layered handles the condensation fine.
  return "layered";
}
