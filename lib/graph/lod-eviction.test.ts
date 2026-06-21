// Bounded offscreen-auto-open eviction (spec → "State machine + committed generations":
// "auto open & offscreen → eviction-eligible … over budget → evict lowest-priority
// eligible reps (LRU)"; Appendix A §J). Phase C1c review bug (b).
//
// The controller persists across recuts (the canvas holds it on a ref): it tracks which
// group proxies are auto-OPENED, keeps on-screen ones fresh (MRU) and lets offscreen ones
// age, and — when the tracked set exceeds the offscreen-open budget — evicts the oldest
// (an offscreen one) so a long exploration can't grow auto-opens without bound. It also
// rolls a RuntimeLodCut IN PLACE (advanceRuntimeCut) across recuts when the rep count is
// unchanged, so there's no fresh Uint32Array per frame.

import { describe, expect, test } from "bun:test";
import { makeEvictionController } from "./lod-eviction";
import { cutFromSelection } from "./lod-cut-solver";
import { buildRepresentationHierarchy } from "./representation";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { directoryGrouping } from "./grouping";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// Several independent top dirs so we can open many groups and force eviction.
const graph: GraphModel = {
  nodes: [
    file("a/f1.c"),
    file("b/f2.c"),
    file("c/f3.c"),
    file("d/f4.c"),
    file("e/f5.c"),
    file("f/f6.c"),
  ],
  edges: [makeEdge("a/f1.c", "b/f2.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const h = buildRepresentationHierarchy(snap, nodeIds);
const groupRep = (id: string) => h.repOfGroup[h.snapshot.groupIds.indexOf(id)];

describe("makeEvictionController — bounds offscreen auto-opens via the LRU", () => {
  test("under budget, nothing is evicted", () => {
    const ctrl = makeEvictionController(h.repCount, 4);
    const a = groupRep("directory:a");
    const b = groupRep("directory:b");
    const ev = ctrl.recordOpen([a, b], () => true); // both on-screen
    expect(ev.evicted.size).toBe(0);
    expect(ev.count).toBe(0);
  });

  test("over budget, the OLDEST offscreen auto-open is evicted (LRU)", () => {
    const ctrl = makeEvictionController(h.repCount, 2); // budget = 2 offscreen opens
    const a = groupRep("directory:a");
    const b = groupRep("directory:b");
    const c = groupRep("directory:c");
    // Open a, then b, then c — all OFFSCREEN (eviction-eligible), inserted oldest→newest.
    ctrl.recordOpen([a], () => false);
    ctrl.recordOpen([a, b], () => false);
    const ev = ctrl.recordOpen([a, b, c], () => false);
    // 3 offscreen opens, budget 2 → the oldest (a) is evicted.
    expect(ev.evicted.has(a)).toBe(true);
    expect(ev.evicted.size).toBe(1);
    expect(ev.count).toBe(1);
  });

  test("on-screen auto-opens are kept FRESH and survive; offscreen ones evict first", () => {
    const ctrl = makeEvictionController(h.repCount, 2);
    const a = groupRep("directory:a");
    const b = groupRep("directory:b");
    const c = groupRep("directory:c");
    // a opened first (oldest), but it stays ON-SCREEN every frame → refreshed to MRU.
    // b, c open later OFFSCREEN. Budget 2 → the oldest *offscreen* (b) evicts, not a.
    ctrl.recordOpen([a], () => true);
    ctrl.recordOpen([a, b], (rep) => rep === a); // a on-screen, b offscreen
    const ev = ctrl.recordOpen([a, b, c], (rep) => rep === a); // a on-screen, b & c offscreen
    expect(ev.evicted.has(a)).toBe(false); // a is fresh (on-screen)
    expect(ev.evicted.has(b)).toBe(true); // b is the oldest offscreen
    expect(ev.count).toBe(1);
  });

  test("a group that CLOSES is dropped from tracking (no longer counts toward the budget)", () => {
    const ctrl = makeEvictionController(h.repCount, 2);
    const a = groupRep("directory:a");
    const b = groupRep("directory:b");
    const c = groupRep("directory:c");
    ctrl.recordOpen([a, b], () => false); // a, b tracked
    // Next frame a closes (not in the open set); only b and c open → 2 ≤ budget, no evict.
    const ev = ctrl.recordOpen([b, c], () => false);
    expect(ev.count).toBe(0);
    expect(ctrl.trackedSize).toBe(2); // a was dropped, b + c tracked
  });

  test("the cumulative eviction count accrues across recuts", () => {
    const ctrl = makeEvictionController(h.repCount, 1); // budget 1 → aggressive eviction
    const a = groupRep("directory:a");
    const b = groupRep("directory:b");
    const c = groupRep("directory:c");
    ctrl.recordOpen([a], () => false);
    const e1 = ctrl.recordOpen([a, b], () => false); // evict a
    const e2 = ctrl.recordOpen([b, c], () => false); // b now tracked; opening c evicts b
    expect(e1.count).toBe(1);
    expect(e2.count).toBeGreaterThanOrEqual(1);
    expect(ctrl.totalEvictions).toBe(e1.count + e2.count);
  });
});

describe("makeEvictionController — rolls a RuntimeLodCut in place (no fresh array)", () => {
  test("advanceCut reuses the SAME selectedEpoch array across recuts (rep count unchanged)", () => {
    const ctrl = makeEvictionController(h.repCount, 4);
    const cut1 = cutFromSelection(h, h.roots, 0);
    const rt1 = ctrl.advanceCut(cut1, h.repCount);
    const arr1 = rt1.selectedEpoch;
    const cut2 = cutFromSelection(
      h,
      [...nodeIds.map((_, i) => h.columns.leafRepresentationByNode[i])],
      1,
    );
    const rt2 = ctrl.advanceCut(cut2, h.repCount);
    // SAME runtime object, SAME backing array — rolled in place (epoch bumped).
    expect(rt2).toBe(rt1);
    expect(rt2.selectedEpoch).toBe(arr1);
    // Membership reflects the NEW cut.
    const selected2 = new Set(cut2.selectedRepresentations);
    for (let r = 0; r < h.repCount; r++) expect(rt2.isSelected(r)).toBe(selected2.has(r));
  });

  test("a CHANGED rep count makes a fresh runtime cut (new array, can't roll in place)", () => {
    const ctrl = makeEvictionController(h.repCount, 4);
    const cut1 = cutFromSelection(h, h.roots, 0);
    const rt1 = ctrl.advanceCut(cut1, h.repCount);
    // A different rep count (e.g. the grouping changed) → allocate a fresh runtime cut.
    const rt2 = ctrl.advanceCut(cut1, h.repCount + 3);
    expect(rt2).not.toBe(rt1);
    expect(rt2.selectedEpoch).not.toBe(rt1.selectedEpoch);
    expect(rt2.selectedEpoch.length).toBe(h.repCount + 3);
  });
});
