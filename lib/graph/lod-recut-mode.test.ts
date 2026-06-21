import { describe, expect, test } from "bun:test";
import { decideRecut } from "./lod-recut-mode";

// Gap 8: recomputeCut used to be scheduled ONLY from the wheel handler, and the camera-band
// guard rejected any recompute unless the zoom band INCREASED. So panning an open region
// off-screen never updated retention/eviction. These tests pin the corrected policy:
//   zoom → band/deadband refine (advance the refined band);
//   pan  → visibility/LRU only (NEVER advance the refined band, never force refinement).

describe("decideRecut — zoom (wheel) is monotonic band refinement", () => {
  test("a higher band refines and advances the refined band", () => {
    const d = decideRecut("wheel", 5, 4);
    expect(d.skip).toBe(false);
    expect(d.mode).toBe("refine");
    expect(d.nextRefinedBand).toBe(5);
  });

  test("the same band is a no-op (no work, no re-collapse)", () => {
    expect(decideRecut("wheel", 4, 4)).toEqual({ skip: true });
  });

  test("a lower band (zoom-out) is a no-op — monotonic, never re-collapses", () => {
    expect(decideRecut("wheel", 2, 4)).toEqual({ skip: true });
  });
});

describe("decideRecut — pan updates visibility/LRU without refining (Gap 8 fix)", () => {
  test("a pan at the SAME band still runs, in visibility mode", () => {
    // This is the exact case the old band guard dropped: pan with no band change.
    const d = decideRecut("pan", 4, 4);
    expect(d.skip).toBe(false);
    expect(d.mode).toBe("visibility");
  });

  test("a pan NEVER advances the refined band (no forced deeper refinement)", () => {
    const d = decideRecut("pan", 4, 4);
    expect(d.mode).toBe("visibility");
    expect(d.nextRefinedBand).toBeUndefined();
  });

  test("a pan runs even when the band happens to be lower than the refined band", () => {
    // Panning while zoomed-out past the refined band must still refresh retention/eviction;
    // visibility is band-independent, so it is never skipped the way a zoom-out is.
    const d = decideRecut("pan", 2, 4);
    expect(d.skip).toBe(false);
    expect(d.mode).toBe("visibility");
    expect(d.nextRefinedBand).toBeUndefined();
  });

  test("a pan never claims to refine — its mode is always visibility", () => {
    for (const [current, refined] of [
      [4, 4],
      [6, 4],
      [1, 4],
    ] as const) {
      expect(decideRecut("pan", current, refined).mode).toBe("visibility");
    }
  });
});
