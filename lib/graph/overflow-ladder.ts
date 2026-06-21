// The overflow ladder — Appendix A §C, the "Space Paradox" resolution. Phase C1c Task 4.
//
// When a group is refined, its children need some EXTENT. If that extent doesn't fit the
// group's reserved box, resolveOverflow escalates through five rungs IN ORDER and returns
// the FIRST that accommodates the refinement — least-disruptive first:
//
//   1. scale          — compact the local layout down to (no further than) `minScale`.
//   2. clip-pan       — the box becomes a viewport into its own larger local layout
//                       (only while the pan stays within `maxPanRatio`).
//   3. borrow-slack   — grow the box into under-filled sibling reserve space.
//   4. grow-envelope  — grow the box within the capped `growthEnvelope` (no ancestor
//                       relayout — the envelope is exactly the "grow without relayout" cap).
//   5. scoped-relayout — a scoped SUBTREE relayout (NEVER global) as the final fallback.
//
// THE invariant (asserted on every rung): a refinement NEVER triggers a GLOBAL relayout —
// `global` is always false. Refinement is gated by the envelope: once even a scoped
// relayout is the answer, the caller may instead retain the proxy (over-envelope =
// over-budget). Pure geometry; no layout ALGORITHM, no React, no GPU.
//
// INTEGRATION STATUS (Phase C1c): staged, unit-tested primitive — NOT yet wired into the
// scene pipeline. (Integration note for the borrow-slack rung: if siblingSlackW/H can ever
// originate from the SAME under-filled sibling reserve, pass an area-aware / per-donor
// slack budget so a simultaneous two-axis borrow can't double-count one sibling's free
// space. Not a concern at this pure-geometry layer.)

import type { Rect } from "./representation";

/** The ladder's rungs, in escalation order (exported so callers/tests share the order). */
export const OVERFLOW_RUNGS = [
  "scale",
  "clip-pan",
  "borrow-slack",
  "grow-envelope",
  "scoped-relayout",
] as const;

export type OverflowRung = (typeof OVERFLOW_RUNGS)[number];

export interface OverflowInput {
  /** The group's reserved box (the space it currently owns). */
  current: Rect;
  /** The extent the refined children need at scale 1 (w×h). */
  required: Rect;
  /** The capped envelope the box may grow into without an ancestor relayout (§C). */
  growthEnvelope: Rect;
  /** Compaction floor in (0,1]: the local layout may shrink to this, no further. */
  minScale: number;
  /** Extra width available by borrowing from under-filled sibling reserves. */
  siblingSlackW: number;
  /** Extra height available by borrowing from under-filled sibling reserves. */
  siblingSlackH: number;
  /**
   * How much larger (in either axis) the compacted local layout may be than the box
   * before clip+pan is rejected in favour of growing. A viewport you must pan more than
   * this through is worse than a (bounded) grow, so the ladder escalates past it.
   */
  maxPanRatio: number;
}

export interface OverflowResolution {
  /** Which rung resolved the overflow. */
  rung: OverflowRung;
  /** The resulting box (== current for scale/clip-pan; grown for borrow/grow/relayout). */
  box: Rect;
  /** Uniform content scale to apply (≤ 1; ≥ minScale on the scale rung). */
  scale: number;
  /** True on the clip-pan rung: the box is a viewport into a larger local layout. */
  clipPan: boolean;
  /** Width/height the box borrowed from sibling reserves (borrow-slack rung). */
  borrowedW: number;
  borrowedH: number;
  /** True on the final rung: a SCOPED subtree relayout is required. */
  scopedRelayout: boolean;
  /** ALWAYS false — a refinement never triggers a global relayout (the §C invariant). */
  global: false;
}

/** Uniform scale to fit `required` into `box` (≤ 1; 1 when it already fits or is empty). */
function fitScale(required: Rect, box: Rect): number {
  if (required.w <= 0 || required.h <= 0) return 1;
  return Math.min(1, box.w / required.w, box.h / required.h);
}

/**
 * Resolve an overflow by walking the §C ladder in order and returning the first rung that
 * accommodates the refinement. `global` is always false: the deepest escalation is a
 * SCOPED subtree relayout, never a global one.
 */
export function resolveOverflow(input: OverflowInput): OverflowResolution {
  const { current, required, growthEnvelope, minScale, siblingSlackW, siblingSlackH, maxPanRatio } =
    input;

  const baseResult = {
    box: current,
    scale: 1,
    clipPan: false,
    borrowedW: 0,
    borrowedH: 0,
    scopedRelayout: false,
    global: false as const,
  };

  // ── Rung 1: scale ─────────────────────────────────────────────────────────────
  // If the content fits when compacted by no more than minScale, just scale it.
  const s = fitScale(required, current);
  if (s >= minScale) {
    return { ...baseResult, rung: "scale", scale: s };
  }

  // Past minScale: the content is genuinely larger than the box can show at the floor
  // scale. Its maximally-compacted footprint (the smallest it can be drawn) is:
  const compactW = required.w * minScale;
  const compactH = required.h * minScale;

  // ── Rung 2: clip + local pan ───────────────────────────────────────────────────
  // Keep the box fixed and treat it as a viewport into the (minScale-compacted) larger
  // local layout — provided the pan distance stays within maxPanRatio in BOTH axes.
  const panRatioW = current.w > 0 ? compactW / current.w : Infinity;
  const panRatioH = current.h > 0 ? compactH / current.h : Infinity;
  if (panRatioW <= maxPanRatio && panRatioH <= maxPanRatio) {
    return { ...baseResult, rung: "clip-pan", scale: minScale, clipPan: true };
  }

  // The box must grow to (at least) the compacted footprint to show everything. Growth is
  // measured from `current`; both axes must reach the compacted footprint.
  const needW = Math.max(current.w, compactW);
  const needH = Math.max(current.h, compactH);

  // ── Rung 3: borrow sibling slack ───────────────────────────────────────────────
  // Grow into under-filled sibling reserves first (no envelope/relayout needed).
  if (current.w + siblingSlackW >= needW && current.h + siblingSlackH >= needH) {
    return {
      ...baseResult,
      rung: "borrow-slack",
      box: { x: current.x, y: current.y, w: needW, h: needH },
      scale: minScale,
      borrowedW: needW - current.w,
      borrowedH: needH - current.h,
    };
  }

  // ── Rung 4: grow within the growthEnvelope ─────────────────────────────────────
  // The envelope is the capped maximum the box may reach WITHOUT an ancestor relayout.
  if (growthEnvelope.w >= needW && growthEnvelope.h >= needH) {
    return {
      ...baseResult,
      rung: "grow-envelope",
      box: { x: current.x, y: current.y, w: needW, h: needH },
      scale: minScale,
    };
  }

  // ── Rung 5: scoped subtree relayout (NEVER global) ─────────────────────────────
  // Even the envelope can't fit it. Grow to the envelope (the most we may without an
  // ancestor relayout) and flag a SCOPED subtree relayout — never a global one.
  return {
    ...baseResult,
    rung: "scoped-relayout",
    box: {
      x: current.x,
      y: current.y,
      w: Math.max(current.w, growthEnvelope.w),
      h: Math.max(current.h, growthEnvelope.h),
    },
    scale: minScale,
    scopedRelayout: true,
  };
}
