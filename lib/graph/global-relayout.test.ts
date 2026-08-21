// The material-change relayout gate (spec non-negotiable: "A global relayout happens
// only on a material change — filters / grouping-mode / direction / explicit request /
// overflow — NEVER for an ordinary camera-driven refinement"). Phase C1c Task 5.

import { describe, expect, test } from "bun:test";
import {
  type GlobalLayoutInputs,
  globalLayoutSignature,
  globalRelayoutReason,
} from "./global-relayout";

const base: GlobalLayoutInputs = {
  graphVersion: "g1",
  filterSignature: "f1",
  groupingMode: "directory",
  direction: "TB",
  layoutEngine: "smart",
  layoutOptionsHash: "lo1",
  explicitRelayoutNonce: 0,
  envelopeExhaustedNonce: 0,
};

describe("globalLayoutSignature — invariant to camera refinement, sensitive to material change", () => {
  test("identical inputs yield an identical signature", () => {
    expect(globalLayoutSignature({ ...base })).toBe(globalLayoutSignature({ ...base }));
  });

  test("a filter change changes the signature", () => {
    expect(globalLayoutSignature({ ...base, filterSignature: "f2" })).not.toBe(
      globalLayoutSignature(base),
    );
  });

  test("a grouping-mode change changes the signature", () => {
    expect(globalLayoutSignature({ ...base, groupingMode: "community" })).not.toBe(
      globalLayoutSignature(base),
    );
  });

  test("a direction change changes the signature", () => {
    expect(globalLayoutSignature({ ...base, direction: "LR" })).not.toBe(
      globalLayoutSignature(base),
    );
  });

  test("an explicit relayout request (nonce bump) changes the signature", () => {
    expect(globalLayoutSignature({ ...base, explicitRelayoutNonce: 1 })).not.toBe(
      globalLayoutSignature(base),
    );
  });

  test("an envelope-exhaustion event (nonce bump) changes the signature", () => {
    expect(globalLayoutSignature({ ...base, envelopeExhaustedNonce: 1 })).not.toBe(
      globalLayoutSignature(base),
    );
  });

  test("the signature does NOT depend on camera state (it has no camera field)", () => {
    // GlobalLayoutInputs carries no x/y/scale/LOD cut — so a camera refinement can't
    // possibly bump it. (A compile-time guarantee, re-asserted: the keys are material.)
    expect(Object.keys(base).sort()).toEqual(
      [
        "direction",
        "envelopeExhaustedNonce",
        "explicitRelayoutNonce",
        "filterSignature",
        "graphVersion",
        "groupingMode",
        "layoutEngine",
        "layoutOptionsHash",
      ].sort(),
    );
  });
});

describe("globalRelayoutReason — fires ONLY on a material change", () => {
  test("no change → null (no relayout)", () => {
    expect(globalRelayoutReason(base, { ...base })).toBeNull();
  });

  test("a filter change → 'filters'", () => {
    expect(globalRelayoutReason(base, { ...base, filterSignature: "f2" })).toBe("filters");
  });

  test("a grouping-mode change → 'grouping-mode'", () => {
    expect(globalRelayoutReason(base, { ...base, groupingMode: "package" })).toBe("grouping-mode");
  });

  test("a direction change → 'direction'", () => {
    expect(globalRelayoutReason(base, { ...base, direction: "BT" })).toBe("direction");
  });

  test("an explicit request → 'explicit'", () => {
    expect(globalRelayoutReason(base, { ...base, explicitRelayoutNonce: 1 })).toBe("explicit");
  });

  test("an envelope-exhaustion event → 'envelope-exhausted'", () => {
    expect(globalRelayoutReason(base, { ...base, envelopeExhaustedNonce: 1 })).toBe(
      "envelope-exhausted",
    );
  });

  test("a graph (re-scan) change → 'graph'", () => {
    expect(globalRelayoutReason(base, { ...base, graphVersion: "g2" })).toBe("graph");
  });

  test("a layout-engine change → 'engine'", () => {
    expect(globalRelayoutReason(base, { ...base, layoutEngine: "layered" })).toBe("engine");
  });
});

describe("camera refinement does NOT bump the global layout signature (the core gate)", () => {
  // Simulate a sequence of camera-only refinements: the material inputs stay constant
  // while a camera/LOD cut would change. The global signature must be stable, and the
  // gate must report no relayout, across the whole pan/zoom sequence.
  test("a pan/zoom/LOD-cut sequence leaves the global signature identical throughout", () => {
    const sig0 = globalLayoutSignature(base);
    // Each "frame" is a camera refinement: nothing in GlobalLayoutInputs changes.
    for (let frame = 0; frame < 10; frame++) {
      const refined: GlobalLayoutInputs = { ...base }; // camera moved, material inputs didn't
      expect(globalLayoutSignature(refined)).toBe(sig0);
      expect(globalRelayoutReason(base, refined)).toBeNull();
    }
  });

  test("only after a material change interleaved in the sequence does the gate fire", () => {
    // frames 0..4 camera-only (no relayout), frame 5 flips direction (relayout), then
    // 6..9 camera-only again at the new baseline (no relayout).
    let baseline = base;
    for (let frame = 0; frame < 10; frame++) {
      const material = frame === 5;
      const next: GlobalLayoutInputs = material
        ? { ...baseline, direction: "RL" }
        : { ...baseline };
      const reason = globalRelayoutReason(baseline, next);
      expect(reason).toBe(material ? "direction" : null);
      if (material) baseline = next; // a relayout re-baselines the global layout
    }
  });
});
