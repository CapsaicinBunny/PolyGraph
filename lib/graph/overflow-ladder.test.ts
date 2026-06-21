// The overflow ladder (spec → Appendix A §C, the "Space Paradox"). Phase C1c Task 4.
//
// When a group's refined contents don't fit its reserved box, resolveOverflow escalates
// through the rungs IN ORDER, choosing the FIRST that accommodates the refinement:
//   1. scale  — compact the local layout down to (no further than) minScale;
//   2. clip-pan — the box becomes a viewport into its own larger local layout;
//   3. borrow-slack — take space from under-filled sibling reserves;
//   4. grow-envelope — grow within the capped growthEnvelope (no ancestor relayout);
//   5. scoped-relayout — a scoped SUBTREE relayout (NEVER global) as the last resort.
// A refinement NEVER triggers a global relayout — asserted on every rung.

import { describe, expect, test } from "bun:test";
import { type OverflowInput, OVERFLOW_RUNGS, resolveOverflow } from "./overflow-ladder";
import type { Rect } from "./representation";

const box = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h });

// A baseline 200×200 reserved box with minScale 0.5 (content may compact to half) and a
// growthEnvelope up to 400×400 (a 4× area cap). No sibling slack unless a test adds it.
const base: Omit<OverflowInput, "required"> = {
  current: box(200, 200),
  growthEnvelope: box(400, 400),
  minScale: 0.5,
  siblingSlackW: 0,
  siblingSlackH: 0,
  maxPanRatio: 1.5,
};

describe("resolveOverflow — rung 1: scale down to minScale", () => {
  test("content that fits at scale 1 needs no compaction (scale = 1)", () => {
    const r = resolveOverflow({ ...base, required: box(180, 180) });
    expect(r.rung).toBe("scale");
    expect(r.scale).toBe(1);
    expect(r.global).toBe(false);
  });

  test("mild overflow compacts to a scale still >= minScale", () => {
    // required 300×300 into 200×200 → fitScale = 0.667 >= minScale 0.5 → scale.
    const r = resolveOverflow({ ...base, required: box(300, 300) });
    expect(r.rung).toBe("scale");
    expect(r.scale).toBeCloseTo(200 / 300, 5);
    expect(r.scale).toBeGreaterThanOrEqual(base.minScale);
    expect(r.global).toBe(false);
  });
});

describe("resolveOverflow — rung 2: clip + local pan", () => {
  test("overflow past minScale but within the pan cap becomes a viewport (box unchanged)", () => {
    // required 360×360: fitScale = 0.556 < minScale 0.5? no, 0.556 > 0.5 → that's scale.
    // Use 420×420: fitScale = 0.476 < 0.5 → past minScale. panRatio = 420*minScale/200
    // = 1.05 <= maxPanRatio 1.5 → clip-pan.
    const r = resolveOverflow({ ...base, required: box(420, 420) });
    expect(r.rung).toBe("clip-pan");
    // The box does NOT grow — it clips and pans over the larger local layout.
    expect(r.box).toEqual(base.current);
    expect(r.global).toBe(false);
  });
});

describe("resolveOverflow — rung 3: borrow sibling slack", () => {
  test("pan too large, but borrowing under-filled sibling reserve fits the box", () => {
    // required 800×800: at minScale 0.5 it needs 400×400; panRatio = 400/200 = 2 > 1.5
    // so clip-pan is rejected. Grant 220 slack in each axis → current 200 + 220 = 420
    // >= 400 needed → borrow-slack (no need to touch the envelope).
    const r = resolveOverflow({
      ...base,
      required: box(800, 800),
      siblingSlackW: 220,
      siblingSlackH: 220,
    });
    expect(r.rung).toBe("borrow-slack");
    // The grown box stays within current + slack.
    expect(r.box.w).toBeLessThanOrEqual(base.current.w + 220);
    expect(r.box.h).toBeLessThanOrEqual(base.current.h + 220);
    expect(r.box.w).toBeGreaterThanOrEqual(400);
    expect(r.global).toBe(false);
  });
});

describe("resolveOverflow — rung 4: grow within the growthEnvelope", () => {
  test("no sibling slack, but the capped envelope fits the box", () => {
    // required 800×800 → needs 400×400 at minScale. No sibling slack. Envelope is 400×400
    // → grow-envelope fits exactly.
    const r = resolveOverflow({ ...base, required: box(800, 800) });
    expect(r.rung).toBe("grow-envelope");
    expect(r.box.w).toBeLessThanOrEqual(base.growthEnvelope.w);
    expect(r.box.h).toBeLessThanOrEqual(base.growthEnvelope.h);
    expect(r.global).toBe(false);
  });

  test("growth is capped at the envelope — never beyond", () => {
    // required 900×900 → needs 450×450 at minScale, but the envelope caps at 400×400.
    // Growing to the envelope still doesn't fully fit → escalates past grow-envelope.
    const r = resolveOverflow({ ...base, required: box(900, 900) });
    expect(r.rung).not.toBe("grow-envelope"); // the envelope can't fit it
  });
});

describe("resolveOverflow — rung 5: scoped subtree relayout (NEVER global)", () => {
  test("envelope exhausted → a scoped subtree relayout, not a global one", () => {
    // required 2000×2000 → needs 1000×1000 at minScale; envelope caps at 400×400 and no
    // slack → every prior rung fails → scoped-relayout.
    const r = resolveOverflow({ ...base, required: box(2000, 2000) });
    expect(r.rung).toBe("scoped-relayout");
    expect(r.scopedRelayout).toBe(true);
    // THE invariant: a refinement never triggers a GLOBAL relayout.
    expect(r.global).toBe(false);
  });
});

describe("resolveOverflow — the ladder is tried strictly in order; never global", () => {
  test("the rung order is exactly the spec's five-step ladder", () => {
    expect(OVERFLOW_RUNGS).toEqual([
      "scale",
      "clip-pan",
      "borrow-slack",
      "grow-envelope",
      "scoped-relayout",
    ]);
  });

  test("r.global is false for a sweep across every overflow magnitude", () => {
    for (const side of [150, 300, 420, 800, 900, 2000, 50000]) {
      const r = resolveOverflow({ ...base, required: box(side, side) });
      expect(r.global).toBe(false);
    }
  });

  test("a degenerate zero-required box resolves trivially at rung 1 (scale 1)", () => {
    const r = resolveOverflow({ ...base, required: box(0, 0) });
    expect(r.rung).toBe("scale");
    expect(r.scale).toBe(1);
    expect(r.global).toBe(false);
  });
});
