// Scene-level wiring of the C1c HierarchicalLayout (spec P3 / Work item 1 / B3): a global
// world layout is decomposed into per-group stable boxes + cached local layouts, and a recut
// REUSES the cached local layout for every group whose ProxyCacheKey is unchanged — so its
// world positions + boxes are byte-identical across the recut. This is the end-to-end
// counterpart of local-refine.test.ts's per-group invariant: refining one group leaves every
// OTHER group byte-identical, now driven through a real (decompose → reconcile → worldScene)
// scene round-trip rather than hand-built reservations.

import { describe, expect, test } from "bun:test";
import {
  buildHierarchicalLayoutFromWorld,
  type GroupKeyFn,
  groupKeyFromMaterial,
  reconcileHierarchicalLayout,
  type SceneMaterialKey,
  UNGROUPED_BOX_KEY,
  type WorldLayoutResult,
  worldScene,
} from "./scene-hierarchical-layout";
import type { ClusterBox } from "../layout";

const material = (over: Partial<SceneMaterialKey> = {}): SceneMaterialKey => ({
  graphVersion: "g1",
  filterSignature: "f1",
  groupingMode: "directory",
  groupingVersion: "gv1",
  layoutEngine: "smart",
  layoutDirection: "TB",
  layoutOptionsHash: "lo1",
  nodeStyleMetricsVersion: "nm1",
  edgeKindsSignature: "ek1",
  representationBuilderVersion: "rb1",
  ...over,
});

const box = (id: string, x: number, y: number, w = 400, h = 300): ClusterBox => ({
  id,
  x,
  y,
  width: w,
  height: h,
  depth: 0,
  label: id,
});

// Two top-level group boxes far apart, each with two nodes inside; plus one ungrouped node
// outside both boxes (a flat/None remainder). A faithful Smart-style world layout.
const world = (): WorldLayoutResult => ({
  positions: new Map([
    ["A/f1", { x: 20, y: 20 }],
    ["A/f2", { x: 20, y: 140 }],
    ["B/f1", { x: 1020, y: 20 }],
    ["B/f2", { x: 1020, y: 140 }],
    ["orphan", { x: 5000, y: 5000 }],
  ]),
  clusters: [box("A", 0, 0), box("B", 1000, 0)],
});

// Snapshot world geometry as sorted plain JSON for a byte-level deep compare.
function snap(layout: ReturnType<typeof buildHierarchicalLayoutFromWorld>) {
  const s = worldScene(layout);
  return {
    positions: [...s.positions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    clusters: [...s.clusters].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

describe("buildHierarchicalLayoutFromWorld — round-trips a world layout", () => {
  test("worldScene reproduces the input node positions (decompose → project is identity)", () => {
    const w = world();
    const layout = buildHierarchicalLayoutFromWorld(w, groupKeyFromMaterial(material()));
    const s = worldScene(layout);
    for (const [id, p] of w.positions) expect(s.positions.get(id)).toEqual(p);
  });

  test("top-level group boxes are reproduced at their world origins", () => {
    const w = world();
    const layout = buildHierarchicalLayoutFromWorld(w, groupKeyFromMaterial(material()));
    const s = worldScene(layout);
    const a = s.clusters.find((c) => c.id === "A");
    const b = s.clusters.find((c) => c.id === "B");
    expect(a).toMatchObject({ x: 0, y: 0, width: 400, height: 300 });
    expect(b).toMatchObject({ x: 1000, y: 0, width: 400, height: 300 });
  });

  test("nodes outside every group box collect into the identity-origin ungrouped reservation", () => {
    const w = world();
    const layout = buildHierarchicalLayoutFromWorld(w, groupKeyFromMaterial(material()));
    expect(layout.order).toContain(UNGROUPED_BOX_KEY);
    expect(worldScene(layout).positions.get("orphan")).toEqual({ x: 5000, y: 5000 });
  });
});

describe("reconcileHierarchicalLayout — byte-identical siblings across a recut", () => {
  test("a recut with the SAME material leaves EVERY group byte-identical even if the worker moved them", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);
    const before = snap(prev);

    // The worker re-runs and returns DIFFERENT coordinates for every group (a fresh global
    // layout). Because no material input changed, reconcile must reuse the cached local layouts
    // and the prior origins → the world scene is byte-identical, no group moved.
    const movedWorld: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 999, y: 999 }],
        ["A/f2", { x: 888, y: 888 }],
        ["B/f1", { x: 1777, y: 777 }],
        ["B/f2", { x: 1666, y: 666 }],
        ["orphan", { x: 12345, y: 12345 }],
      ]),
      clusters: [box("A", 500, 500), box("B", 2000, 200)],
    };
    const next = reconcileHierarchicalLayout(prev, movedWorld, keyFor);
    expect(snap(next)).toEqual(before);
  });

  test("changing ONE group's material moves ONLY that group; every other group byte-identical", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);
    const before = snap(prev);
    const othersBefore = {
      positions: before.positions.filter(([id]) => !id.startsWith("A")),
      clusters: before.clusters.filter((c) => c.id !== "A"),
    };

    // Per-group key fn: group "A" gets a CHANGED key (e.g. it refined → different rep id), all
    // others keep their material key. Only A's cache entry misses → only A is re-decomposed.
    const changedKeyFor: GroupKeyFn = (boxKey) =>
      boxKey === "A" ? { ...keyFor(boxKey), representationBuilderVersion: "rb2" } : keyFor(boxKey);

    const movedWorld: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 30, y: 30 }], // A's children land at new local coords
        ["A/f2", { x: 30, y: 200 }],
        ["B/f1", { x: 1020, y: 20 }], // B unchanged in the worker output, but reuse must win
        ["B/f2", { x: 1020, y: 140 }],
        ["orphan", { x: 5000, y: 5000 }],
      ]),
      clusters: [box("A", 0, 0), box("B", 1000, 0)],
    };
    const next = reconcileHierarchicalLayout(prev, movedWorld, changedKeyFor);
    const after = snap(next);
    const othersAfter = {
      positions: after.positions.filter(([id]) => !id.startsWith("A")),
      clusters: after.clusters.filter((c) => c.id !== "A"),
    };
    // B + orphan byte-identical.
    expect(othersAfter).toEqual(othersBefore);
    // A actually moved (the refinement took effect).
    expect(after.positions.find(([id]) => id === "A/f1")?.[1]).toEqual({ x: 30, y: 30 });
  });

  test("the cache is shared across recuts: an unchanged group is a cache HIT (no re-decompose)", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);
    const cachedA = prev.cache.get("A", keyFor("A"));
    expect(cachedA).toBeDefined();
    // Reconcile reuses the SAME cached object reference for the unchanged group.
    const next = reconcileHierarchicalLayout(prev, world(), keyFor);
    expect(next.cache.get("A", keyFor("A"))).toBe(cachedA);
  });

  test("a material flip (e.g. direction) re-decomposes ALL groups (no stale reuse)", () => {
    const prev = buildHierarchicalLayoutFromWorld(world(), groupKeyFromMaterial(material()));
    // New direction → every group's key changes → no reuse; the new world coords take effect.
    const flippedKeyFor = groupKeyFromMaterial(material({ layoutDirection: "LR" }));
    const movedWorld: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 11, y: 11 }],
        ["A/f2", { x: 11, y: 99 }],
        ["B/f1", { x: 1011, y: 11 }],
        ["B/f2", { x: 1011, y: 99 }],
        ["orphan", { x: 7000, y: 7000 }],
      ]),
      clusters: [box("A", 0, 0), box("B", 1000, 0)],
    };
    const next = reconcileHierarchicalLayout(prev, movedWorld, flippedKeyFor);
    const s = worldScene(next);
    // The new coordinates won (nothing reused), so A/f1 reflects the fresh layout.
    expect(s.positions.get("A/f1")).toEqual({ x: 11, y: 11 });
    expect(s.positions.get("B/f2")).toEqual({ x: 1011, y: 99 });
  });
});
