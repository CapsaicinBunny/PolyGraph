// Camera-driven recut policy (design Gap 8). The adaptive cut is recomputed from two
// distinct camera gestures with DIFFERENT semantics:
//
//   • ZOOM  → band/deadband REFINE. Zooming in past a band boundary may open more detail.
//             Monotonic: only ever refines (never re-collapses on zoom-out); the band the
//             solver refined to advances so each gesture refines once after it settles.
//   • PAN   → VISIBILITY / LRU only. Panning an open region off-screen must update which
//             proxies are on-screen (retention) and the offscreen-auto-open eviction LRU —
//             but it must NOT force deeper refinement (the band the solver refined to is
//             unchanged). Before this, recomputeCut ran only from the wheel handler and the
//             band guard rejected any recompute unless the zoom band INCREASED, so a pan that
//             carried an open region off-screen never updated retention/eviction.
//
// This module is the pure decision: given the trigger and the band the solver last refined
// to vs. the current camera band, decide whether to run a recut and, if so, in which mode.

/** Why the recut was scheduled. `wheel` = a zoom gesture; `pan` = a drag-to-pan gesture. */
export type RecutTrigger = "wheel" | "pan";

/** What a scheduled recut should do once it runs. */
export type RecutMode =
  // Refine to the current (higher) zoom band — advance the refined band.
  | "refine"
  // Refresh on-screen visibility + the eviction LRU at the SAME refined band (no refinement).
  | "visibility";

export interface RecutDecision {
  /** Skip the recut entirely (no band change worth acting on). */
  readonly skip: boolean;
  /** Present iff `skip` is false. */
  readonly mode?: RecutMode;
  /** The band the solver should treat as "refined to" after this recut (for `refine` only). */
  readonly nextRefinedBand?: number;
}

const SKIP: RecutDecision = { skip: true };

/**
 * Decide what a camera-triggered recut should do.
 *
 * @param trigger       the gesture that scheduled the recut (`wheel` = zoom, `pan` = drag)
 * @param currentBand   the current camera band ({@link import("./lod-scene").cameraBand})
 * @param refinedBand   the band the solver last REFINED to (monotonic; advances on zoom-in)
 *
 * Semantics (Gap 8 — "zoom → band/deadband refine; pan → visibility/LRU only"):
 *  - `wheel` with a HIGHER band than refined → `refine` (advance the refined band).
 *  - `wheel` at/below the refined band → skip (monotonic: never re-collapse on zoom-out, and
 *    no work to do when the band hasn't advanced).
 *  - `pan` → ALWAYS `visibility` (refresh retention/eviction at the current band) WITHOUT
 *    advancing the refined band, so a pan never forces deeper refinement.
 */
export function decideRecut(
  trigger: RecutTrigger,
  currentBand: number,
  refinedBand: number,
): RecutDecision {
  if (trigger === "pan") {
    // Pan never refines: visibility + LRU only, at the band the solver already refined to.
    return { skip: false, mode: "visibility" };
  }
  // Zoom: only ever refine, and only when the band has actually advanced past the refined one.
  if (currentBand <= refinedBand) return SKIP;
  return { skip: false, mode: "refine", nextRefinedBand: currentBand };
}
