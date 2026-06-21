// Tiered representation bounds — Appendix A §C, the "Space Paradox" resolution.
//
// A proxy reserves space for the NEXT refinement tier (`nextReserved`) plus a capped
// `growthEnvelope` — NEVER the literal full-leaf extent of a huge subtree. The next-tier
// reservation scales with the DIRECT child count, and the envelope is bounded to a fixed
// multiple of the current box, so a 5000-leaf directory reserves ~`maxEnvelopeFactor`× its
// proxy card, not 5000×. Reservation is recomputed lazily (a single `only` rep) so refining
// one group never perturbs a sibling's or ancestor's reservation. Pure; fills the columnar
// geometry C1b stubbed (`reserved*` / `envelope*` / `minScale`).

import type { RepresentationColumns, RepresentationHierarchy, Rect } from "./representation";

export interface RepresentationBounds {
  /** The proxy's current rendered box. */
  current: Rect;
  /** Room reserved for the next refinement tier (bounded by the direct-child count). */
  nextReserved: Rect;
  /** The capped maximum the box may grow to without an ancestor relayout. */
  growthEnvelope: Rect;
  /** Compaction factor in (0,1]: < 1 when the next tier overflows the current box, else 1. */
  minScale: number;
}

export interface BoundsOptions {
  /** `growthEnvelope` area is capped at `current area × maxEnvelopeFactor`. */
  maxEnvelopeFactor: number;
  /** Slack multiplier applied to the next-tier reservation. */
  tierSlack: number;
  /** Recompute ONLY this rep (lazy local recompute) — every other rep is left untouched. */
  only?: number;
}

export const DEFAULT_BOUNDS_OPTIONS: BoundsOptions = {
  maxEnvelopeFactor: 8,
  tierSlack: 1.5,
};

/** Read a rep's four geometry tiers (current / nextReserved / growthEnvelope / minScale). */
export function representationBoundsOf(
  cols: RepresentationColumns,
  rep: number,
): RepresentationBounds {
  return {
    current: {
      x: cols.boundsX[rep],
      y: cols.boundsY[rep],
      w: cols.boundsW[rep],
      h: cols.boundsH[rep],
    },
    nextReserved: {
      x: cols.reservedX[rep],
      y: cols.reservedY[rep],
      w: cols.reservedW[rep],
      h: cols.reservedH[rep],
    },
    growthEnvelope: {
      x: cols.envelopeX[rep],
      y: cols.envelopeY[rep],
      w: cols.envelopeW[rep],
      h: cols.envelopeH[rep],
    },
    minScale: cols.minScale[rep],
  };
}

function directChildCount(cols: RepresentationColumns, rep: number): number {
  let n = 0;
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) n++;
  return n;
}

/**
 * Fill `reserved*` / `envelope*` / `minScale` from each rep's `current` box (`bounds*`).
 * With `options.only` set, recomputes a single rep in place so a local refinement never
 * touches sibling or ancestor reservations.
 */
export function computeRepresentationBounds(
  h: RepresentationHierarchy,
  options: BoundsOptions = DEFAULT_BOUNDS_OPTIONS,
): void {
  const cols = h.columns;
  const { maxEnvelopeFactor, tierSlack, only } = options;

  const computeOne = (rep: number): void => {
    const x = cols.boundsX[rep];
    const y = cols.boundsY[rep];
    const w = cols.boundsW[rep];
    const hgt = cols.boundsH[rep];
    const curArea = w * hgt;
    const kids = directChildCount(cols, rep);

    if (kids === 0 || curArea <= 0) {
      // A leaf (or a degenerate zero box) has nothing to grow into: every tier == current.
      cols.reservedX[rep] = x;
      cols.reservedY[rep] = y;
      cols.reservedW[rep] = w;
      cols.reservedH[rep] = hgt;
      cols.envelopeX[rep] = x;
      cols.envelopeY[rep] = y;
      cols.envelopeW[rep] = w;
      cols.envelopeH[rep] = hgt;
      cols.minScale[rep] = 1;
      return;
    }

    // Envelope: a fixed cap on growth. THIS is what bounds the Space Paradox — a huge
    // subtree can never reserve more than `maxEnvelopeFactor` × its proxy card.
    const envArea = curArea * maxEnvelopeFactor;
    // Next tier: room for the DIRECT children (~kids+1 footprints with slack), but never
    // beyond the envelope. Scales with direct children, NOT the descendant-leaf total.
    const nextArea = Math.min((kids + 1) * tierSlack * curArea, envArea);

    const sReserved = Math.sqrt(nextArea / curArea);
    const sEnv = Math.sqrt(envArea / curArea);
    cols.reservedX[rep] = x;
    cols.reservedY[rep] = y;
    cols.reservedW[rep] = w * sReserved;
    cols.reservedH[rep] = hgt * sReserved;
    cols.envelopeX[rep] = x;
    cols.envelopeY[rep] = y;
    cols.envelopeW[rep] = w * sEnv;
    cols.envelopeH[rep] = hgt * sEnv;

    // Compaction: the direct children need ~`kids` current-footprints; if that overflows
    // the current box the local layout must shrink to fit → minScale < 1. One child fits.
    cols.minScale[rep] = Math.min(1, 1 / Math.sqrt(kids));
  };

  if (only !== undefined) {
    computeOne(only);
    return;
  }
  for (let r = 0; r < h.repCount; r++) computeOne(r);
}
