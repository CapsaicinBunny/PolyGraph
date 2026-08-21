// THE core C1c invariant (spec → "Global layout stability", "Local refinement"): a
// refinement updates ONLY the refined group's box contents — every OTHER group's box
// and every other node position is BYTE-IDENTICAL before and after. Opening one
// directory must not move any other directory.

import { describe, expect, test } from "bun:test";
import {
  type GroupReservation,
  type HierarchicalLayout,
  makeHierarchicalLayout,
  refineGroup,
  worldScene,
} from "./local-refine";
import type { CachedLocalLayout, ProxyCacheKey } from "./local-layout";

const keyFor = (rep: number): ProxyCacheKey => ({
  graphVersion: "g1",
  filterSignature: "f1",
  groupingMode: "directory",
  groupingVersion: "gv1",
  layoutEngine: "smart",
  layoutDirection: "TB",
  layoutOptionsHash: "lo1",
  nodeStyleMetricsVersion: "nm1",
  edgeKindsSignature: "ek1",
  representationId: rep,
  representationBuilderVersion: "rb1",
});

// Three reserved boxes (the stable repository layout), each with a coarse single-card
// local layout (the proxy stands in for its subtree until refined).
const reservations = (): GroupReservation[] => [
  {
    boxKey: "a",
    origin: { x: 0, y: 0 },
    key: keyFor(0),
    coarse: {
      positions: new Map([["a", { x: 10, y: 10 }]]),
      clusters: [],
      width: 220,
      height: 80,
    },
  },
  {
    boxKey: "b",
    origin: { x: 1000, y: 0 },
    key: keyFor(1),
    coarse: {
      positions: new Map([["b", { x: 10, y: 10 }]]),
      clusters: [],
      width: 220,
      height: 80,
    },
  },
  {
    boxKey: "c",
    origin: { x: 0, y: 1000 },
    key: keyFor(2),
    coarse: {
      positions: new Map([["c", { x: 10, y: 10 }]]),
      clusters: [],
      width: 220,
      height: 80,
    },
  },
];

// A refined local layout for group "a": its two child files, laid out WITHIN a's box
// (local coordinates; the box origin offsets them into world space).
const refinedA = (): CachedLocalLayout => ({
  positions: new Map([
    ["a/f1.c", { x: 8, y: 8 }],
    ["a/f2.c", { x: 8, y: 120 }],
  ]),
  clusters: [],
  width: 220,
  height: 240,
});

/** Snapshot world geometry as plain JSON so "byte-identical" is a deep value compare. */
function snapshot(layout: HierarchicalLayout) {
  const s = worldScene(layout);
  return {
    positions: [...s.positions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    clusters: [...s.clusters].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

describe("refineGroup — updates ONLY the refined box, others byte-identical", () => {
  test("refining 'a' leaves every OTHER group's node positions byte-identical", () => {
    const layout = makeHierarchicalLayout(reservations());
    const before = snapshot(layout);
    const otherBefore = before.positions.filter(([id]) => !id.startsWith("a"));

    refineGroup(layout, "a", refinedA(), keyFor(0));

    const after = snapshot(layout);
    const otherAfter = after.positions.filter(([id]) => !id.startsWith("a"));
    // b and c node positions are unchanged to the byte.
    expect(otherAfter).toEqual(otherBefore);
  });

  test("refining 'a' leaves every OTHER group's box byte-identical", () => {
    const layout = makeHierarchicalLayout(reservations());
    // Seed a nested box inside b so there's a non-trivial box to preserve.
    refineGroup(
      layout,
      "b",
      {
        positions: new Map([["b/f4.c", { x: 8, y: 8 }]]),
        clusters: [{ id: "b/inner", x: 4, y: 4, width: 100, height: 60, depth: 1, label: "inner" }],
        width: 220,
        height: 120,
      },
      keyFor(1),
    );
    const before = snapshot(layout);
    const bAndCBoxesBefore = before.clusters.filter((c) => !c.id.startsWith("a"));

    refineGroup(layout, "a", refinedA(), keyFor(0));

    const after = snapshot(layout);
    const bAndCBoxesAfter = after.clusters.filter((c) => !c.id.startsWith("a"));
    expect(bAndCBoxesAfter).toEqual(bAndCBoxesBefore);
  });

  test("the refined group's OWN contents DO change (the refinement took effect)", () => {
    const layout = makeHierarchicalLayout(reservations());
    refineGroup(layout, "a", refinedA(), keyFor(0));
    const s = worldScene(layout);
    // a's children now appear at world = local + a.origin (0,0).
    expect(s.positions.get("a/f1.c")).toEqual({ x: 8, y: 8 });
    expect(s.positions.get("a/f2.c")).toEqual({ x: 8, y: 120 });
    // The coarse single-card "a" placeholder is gone (replaced by its children).
    expect(s.positions.has("a")).toBe(false);
  });

  test("refining the SAME group twice still leaves siblings byte-identical (idempotent isolation)", () => {
    const layout = makeHierarchicalLayout(reservations());
    const otherBefore = snapshot(layout).positions.filter(([id]) => !id.startsWith("a"));
    refineGroup(layout, "a", refinedA(), keyFor(0));
    refineGroup(
      layout,
      "a",
      {
        positions: new Map([["a/f1.c", { x: 0, y: 0 }]]),
        clusters: [],
        width: 220,
        height: 80,
      },
      keyFor(0),
    );
    const otherAfter = snapshot(layout).positions.filter(([id]) => !id.startsWith("a"));
    expect(otherAfter).toEqual(otherBefore);
  });

  test("a committed refinement is cached: re-projecting with the SAME key reuses it", () => {
    const layout = makeHierarchicalLayout(reservations());
    const rl = refinedA();
    refineGroup(layout, "a", rl, keyFor(0));
    // The cache now holds a's refined local layout under its key (a cache hit).
    expect(layout.cache.get("a", keyFor(0))).toBe(rl);
  });

  test("refining a box origin that sits away from (0,0) offsets correctly without moving siblings", () => {
    const layout = makeHierarchicalLayout(reservations());
    const before = snapshot(layout);
    const nonBBefore = before.positions.filter(([id]) => !id.startsWith("b"));
    refineGroup(
      layout,
      "b",
      {
        positions: new Map([["b/f4.c", { x: 8, y: 8 }]]),
        clusters: [],
        width: 220,
        height: 80,
      },
      keyFor(1),
    );
    const s = worldScene(layout);
    // b sits at world origin (1000,0) → its child lands at (1008, 8).
    expect(s.positions.get("b/f4.c")).toEqual({ x: 1008, y: 8 });
    // a and c unchanged.
    const nonBAfter = snapshot(layout).positions.filter(([id]) => !id.startsWith("b"));
    expect(nonBAfter).toEqual(nonBBefore);
  });
});
