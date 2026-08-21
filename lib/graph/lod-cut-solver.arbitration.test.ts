// Deterministic forced-open arbitration (design spec point 7 + "Deterministic forced-open
// arbitration"). When several explicit opens jointly exceed a HARD budget, WHICH opens are
// honored — and which surface "Detail limited" — must be a function of the priority order
// (clicked → highlighted path → most-recently-interacted → viewport-center → stable rep id),
// NEVER of the `forceOpen` Set's insertion order. These tests pin both:
//   (1) a deterministic outcome regardless of Set iteration order, and
//   (2) the correct LimitedDetail entries for the opens that were capped.

import { describe, expect, test } from "bun:test";
import { buildRepresentationHierarchy, type RepresentationHierarchy } from "./representation";
import { type CompactGroupingSnapshot } from "./grouping-snapshot";
import {
  arbitrateForceOpen,
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  type ForceOpenArbitration,
  type LimitedDetail,
  type LodBudget,
  type SolveDiagnostics,
  solveLodCut,
} from "./lod-cut-solver";

const cam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };

/**
 * A flat snapshot of `groupCount` ROOT groups, each owning `leavesPerGroup` leaves. Every
 * group proxy is a sibling root — so force-opening any subset competes on the SAME budget,
 * which is exactly the arbitration scenario (point 7).
 */
function flatGroups(groupCount: number, leavesPerGroup: number): CompactGroupingSnapshot {
  const groupIds = Array.from({ length: groupCount }, (_, g) => `g:${g}`);
  const directGroupByNode = new Uint32Array(groupCount * leavesPerGroup);
  for (let g = 0; g < groupCount; g++) {
    for (let i = 0; i < leavesPerGroup; i++) {
      directGroupByNode[g * leavesPerGroup + i] = g;
    }
  }
  return {
    modeKey: "synthetic",
    groupIds,
    groupLabels: groupIds,
    parentByGroup: Int32Array.from(Array.from({ length: groupCount }, () => -1)),
    depthByGroup: Uint16Array.from(Array.from({ length: groupCount }, () => 0)),
    boxKeyByGroup: groupIds.map((id) => `box:${id}`),
    directGroupByNode,
    roots: Uint32Array.from(Array.from({ length: groupCount }, (_, g) => g)),
  };
}

function buildFlat(groupCount: number, leavesPerGroup: number): RepresentationHierarchy {
  const ids: string[] = [];
  for (let g = 0; g < groupCount; g++) {
    for (let i = 0; i < leavesPerGroup; i++) ids.push(`g${g}_n${i}`);
  }
  return buildRepresentationHierarchy(flatGroups(groupCount, leavesPerGroup), ids);
}

/** rep id of root group `g`. */
const grp = (h: RepresentationHierarchy, g: number) => h.repOfGroup[g];

/** A budget gating purely on CARDS; the other dimensions are huge-but-finite. */
function cardBudget(targetCards: number, hardCards: number): LodBudget {
  return {
    targetCards,
    hardCards,
    targetLayoutCost: 1_000_000,
    hardLayoutCost: 1_000_000,
    targetEdges: 1e9,
    hardEdges: 1e9,
    targetLabels: 1e9,
    hardLabels: 1e9,
    maxGpuBytes: 1_000_000_000,
  };
}

const emptyDiag = (): SolveDiagnostics => ({
  whyNotRefined: new Map(),
  refinements: 0,
  limited: [],
});

describe("arbitrateForceOpen — total deterministic order (design point 7)", () => {
  test("clicked beats highlighted beats recency beats viewport-center beats rep id", () => {
    const h = buildFlat(5, 2);
    const r0 = grp(h, 0);
    const r1 = grp(h, 1);
    const r2 = grp(h, 2);
    const r3 = grp(h, 3);
    const r4 = grp(h, 4);
    const arbitration: ForceOpenArbitration = {
      clicked: r3,
      highlightedPath: new Set([r1]),
      recency: new Map([[r4, 100]]),
    };
    const order = arbitrateForceOpen(h.columns, cam, new Set([r0, r1, r2, r3, r4]), arbitration);
    // clicked (r3) first; highlighted (r1) next; most-recent (r4) next; then the remaining
    // two (no signal, no geometry) by stable rep id ascending (r0 < r2).
    expect(order).toEqual([r3, r1, r4, r0, r2]);
  });

  test("order is identical regardless of Set insertion order (the core determinism guarantee)", () => {
    const h = buildFlat(6, 2);
    const reps = [grp(h, 0), grp(h, 1), grp(h, 2), grp(h, 3), grp(h, 4), grp(h, 5)];
    const arbitration: ForceOpenArbitration = {
      clicked: reps[5],
      highlightedPath: new Set([reps[0]]),
      recency: new Map([
        [reps[2], 5],
        [reps[4], 9],
      ]),
    };
    const forward = new Set(reps);
    const reverse = new Set([...reps].reverse());
    const shuffled = new Set([reps[3], reps[0], reps[5], reps[2], reps[4], reps[1]]);
    const a = arbitrateForceOpen(h.columns, cam, forward, arbitration);
    const b = arbitrateForceOpen(h.columns, cam, reverse, arbitration);
    const c = arbitrateForceOpen(h.columns, cam, shuffled, arbitration);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    // And the order is the expected priority resolution:
    // clicked r5, highlighted r0, recency r4(9) then r2(5), then rep-id r1 < r3.
    expect(a).toEqual([reps[5], reps[0], reps[4], reps[2], reps[1], reps[3]]);
  });

  test("with NO arbitration signals, falls back to viewport-center then stable rep id", () => {
    const h = buildFlat(3, 2);
    const r0 = grp(h, 0);
    const r1 = grp(h, 1);
    const r2 = grp(h, 2);
    // Position bounds so r2 is nearest the viewport centre, r0 farthest. (boundsW/H > 0 so
    // the geometry tier is active.) Centre of an 800×600 viewport is (400, 300).
    const c = h.columns;
    c.boundsX[r0] = 0;
    c.boundsY[r0] = 0;
    c.boundsW[r0] = 10;
    c.boundsH[r0] = 10; // centre (5,5) — far
    c.boundsX[r1] = 200;
    c.boundsY[r1] = 200;
    c.boundsW[r1] = 10;
    c.boundsH[r1] = 10; // centre (205,205) — middle
    c.boundsX[r2] = 395;
    c.boundsY[r2] = 295;
    c.boundsW[r2] = 10;
    c.boundsH[r2] = 10; // centre (400,300) — exact centre
    const order = arbitrateForceOpen(h.columns, cam, new Set([r0, r1, r2]));
    expect(order).toEqual([r2, r1, r0]);
  });

  test("geometry-less reps sort after positioned reps, ordered by stable rep id", () => {
    const h = buildFlat(3, 2);
    const r0 = grp(h, 0);
    const r1 = grp(h, 1);
    const r2 = grp(h, 2);
    // Only r1 has geometry → it sorts first; r0, r2 (no bounds) fall to rep-id ascending.
    const c = h.columns;
    c.boundsX[r1] = 390;
    c.boundsY[r1] = 290;
    c.boundsW[r1] = 20;
    c.boundsH[r1] = 20;
    const order = arbitrateForceOpen(h.columns, cam, new Set([r2, r0, r1]));
    expect(order).toEqual([r1, r0, r2]);
  });

  test("non-finite recency (NaN/±∞) stays deterministic across Set order", () => {
    // A malformed recency counter (NaN, +∞, −∞) must NOT make the comparator return NaN — that
    // would make Array.sort order-dependent and reintroduce Set-iteration non-determinism. A
    // non-finite recency normalizes to "least recent", so only the finite entry discriminates.
    const h = buildFlat(4, 2);
    const r = [grp(h, 0), grp(h, 1), grp(h, 2), grp(h, 3)];
    const arbitration: ForceOpenArbitration = {
      recency: new Map([
        [r[1], NaN],
        [r[2], 5], // the only finite recency → r2 first
        [r[3], Number.POSITIVE_INFINITY],
      ]),
    };
    const a = arbitrateForceOpen(h.columns, cam, new Set(r), arbitration);
    const b = arbitrateForceOpen(h.columns, cam, new Set([...r].reverse()), arbitration);
    const c = arbitrateForceOpen(h.columns, cam, new Set([r[3], r[1], r[0], r[2]]), arbitration);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    // r2 (finite recency) wins; the non-finite/absent ones fall to stable rep id ascending.
    expect(a).toEqual([r[2], r[0], r[1], r[3]]);
  });

  test("pure — does not mutate the input Set", () => {
    const h = buildFlat(3, 2);
    const set = new Set([grp(h, 2), grp(h, 0), grp(h, 1)]);
    const snapshot = [...set];
    arbitrateForceOpen(h.columns, cam, set);
    expect([...set]).toEqual(snapshot);
  });
});

describe("solveLodCut — arbitration drives which opens are honored vs 'Detail limited'", () => {
  // 4 root groups, 3 leaves each. Root cut = 4 cards. Each full open of a group adds 2 cards
  // (3 leaves − 1 proxy). hardCards = 6 → budget for exactly ONE full open beyond the root
  // (4 + 2 = 6); a SECOND open would need 8 > 6. So when two opens are forced, the
  // higher-priority one is honored and the other is capped → LimitedDetail.
  const make = () => buildFlat(4, 3);

  test("the higher-priority open is honored; the lower-priority one is capped (deterministic)", () => {
    const h = make();
    const clicked = grp(h, 2);
    const other = grp(h, 0);
    const budget = cardBudget(1, 6);
    const arbitration: ForceOpenArbitration = { clicked };

    const run = (forceOpen: Set<number>) => {
      const diag = emptyDiag();
      const cut = solveLodCut(
        h,
        bootstrapCut(h),
        { forceClosed: new Set(), forceOpen, arbitration } satisfies CutConstraints,
        cam,
        budget,
        { diagnostics: diag },
      );
      return { cut, diag };
    };

    // Same two opens, opposite Set insertion order → identical outcome.
    const fwd = run(new Set([clicked, other]));
    const rev = run(new Set([other, clicked]));

    // Clicked group (r2) was opened: its proxy is gone, leaves present.
    expect(new Set(fwd.cut.selectedRepresentations).has(clicked)).toBe(false);
    // Lower-priority group (r0) retained as its proxy — it was capped.
    expect(new Set(fwd.cut.selectedRepresentations).has(other)).toBe(true);
    // Deterministic: byte-identical cut whichever way the Set was built.
    expect([...fwd.cut.selectedRepresentations]).toEqual([...rev.cut.selectedRepresentations]);

    // Within the finite hard ceiling — never expanded to the whole graph.
    expect(fwd.cut.cardCost).toBeLessThanOrEqual(budget.hardCards);

    // Exactly ONE LimitedDetail, for the capped (lower-priority) open, naming the cards budget.
    expect(fwd.diag.limited.length).toBe(1);
    const ld = fwd.diag.limited[0] as LimitedDetail;
    expect(ld.requestedRep).toBe(other);
    expect(ld.resolvedRep).toBe(other); // retained at its own proxy (nearest legal)
    expect(ld.limitingBudget).toBe("cards");
    // And the capped open is the same one regardless of insertion order.
    expect(rev.diag.limited.map((l) => l.requestedRep)).toEqual([other]);
  });

  test("highlighted path outranks an un-flagged open when only one fits", () => {
    const h = make();
    const highlighted = grp(h, 3);
    const plain = grp(h, 1);
    const budget = cardBudget(1, 6);
    const arbitration: ForceOpenArbitration = { highlightedPath: new Set([highlighted]) };
    const diag = emptyDiag();
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([plain, highlighted]), arbitration },
      cam,
      budget,
      { diagnostics: diag },
    );
    // The highlighted open is honored; the plain one is capped.
    expect(new Set(cut.selectedRepresentations).has(highlighted)).toBe(false);
    expect(new Set(cut.selectedRepresentations).has(plain)).toBe(true);
    expect(diag.limited.map((l) => l.requestedRep)).toEqual([plain]);
  });

  test("when several opens are capped, every capped open gets its own LimitedDetail", () => {
    const h = make();
    const clicked = grp(h, 0);
    const capped1 = grp(h, 1);
    const capped2 = grp(h, 3);
    const budget = cardBudget(1, 6); // room for one full open only
    const arbitration: ForceOpenArbitration = { clicked };
    const diag = emptyDiag();
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([capped1, clicked, capped2]), arbitration },
      cam,
      budget,
      { diagnostics: diag },
    );
    // Clicked honored; the two others capped — each surfaces a LimitedDetail.
    expect(new Set(cut.selectedRepresentations).has(clicked)).toBe(false);
    const cappedReqs = new Set(diag.limited.map((l) => l.requestedRep));
    expect(cappedReqs.has(capped1)).toBe(true);
    expect(cappedReqs.has(capped2)).toBe(true);
    expect(cappedReqs.has(clicked)).toBe(false); // the honored one is NOT limited
    expect(cut.cardCost).toBeLessThanOrEqual(budget.hardCards);
  });

  test("all opens honored when they all fit — no LimitedDetail regardless of order", () => {
    const h = make();
    const a = grp(h, 0);
    const b = grp(h, 1);
    const budget = cardBudget(1, 100); // plenty of room for both
    const arbitration: ForceOpenArbitration = { clicked: a };
    const diag = emptyDiag();
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([b, a]), arbitration },
      cam,
      budget,
      { diagnostics: diag },
    );
    expect(new Set(cut.selectedRepresentations).has(a)).toBe(false);
    expect(new Set(cut.selectedRepresentations).has(b)).toBe(false);
    expect(diag.limited.length).toBe(0);
  });

  test("backward-compatible: omitting `arbitration` still produces a deterministic outcome", () => {
    const h = make();
    const lo = grp(h, 0);
    const hi = grp(h, 3);
    const budget = cardBudget(1, 6);
    // No arbitration signals → fallback to viewport-center (none here) then stable rep id, so
    // the LOWER rep id (lo) is honored. Deterministic regardless of Set order.
    const run = (fo: Set<number>) => {
      const diag = emptyDiag();
      const cut = solveLodCut(
        h,
        bootstrapCut(h),
        { forceClosed: new Set(), forceOpen: fo },
        cam,
        budget,
        { diagnostics: diag },
      );
      return { cut, diag };
    };
    const fwd = run(new Set([lo, hi]));
    const rev = run(new Set([hi, lo]));
    expect([...fwd.cut.selectedRepresentations]).toEqual([...rev.cut.selectedRepresentations]);
    // lower rep id wins the budget; the higher one is capped.
    expect(new Set(fwd.cut.selectedRepresentations).has(lo)).toBe(false);
    expect(new Set(fwd.cut.selectedRepresentations).has(hi)).toBe(true);
    expect(fwd.diag.limited.map((l) => l.requestedRep)).toEqual([hi]);
  });
});
