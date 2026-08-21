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
    // Each group AND its members move together, so every group's MEMBERSHIP is unchanged and only
    // the coordinates differ — the pure-relayout case reuse exists for. (Moving the boxes while
    // leaving the nodes behind would drop every node out of its box into the ungrouped remainder:
    // a genuine content change, which reconcile is now required to honour.)
    // The LOCAL offsets must differ from the cached ones too. Coordinates that reduce to the same
    // offsets (e.g. A/f1 at (520,520) against box A at (500,500) → local (20,20), exactly what is
    // cached) would satisfy this assertion whether or not the cache was consulted, so they would
    // only prove origins are pinned. These perturb the locals while keeping membership identical,
    // so byte-identity can hold ONLY if the cached local layout was genuinely reused.
    const movedWorld: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 560, y: 700 }],
        ["A/f2", { x: 820, y: 520 }],
        ["B/f1", { x: 2350, y: 460 }],
        ["B/f2", { x: 2010, y: 210 }],
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
    const changedKeyFor: GroupKeyFn = (boxKey, contentId) =>
      boxKey === "A"
        ? { ...keyFor(boxKey, contentId), representationBuilderVersion: "rb2" }
        : keyFor(boxKey, contentId);

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
    // Read the key the builder actually stored (it carries A's content digest) rather than
    // re-deriving a contentId-less one, which is a different key by construction.
    const keyA = prev.activeKey.get("A")!;
    const cachedA = prev.cache.get("A", keyA);
    expect(cachedA).toBeDefined();
    // Reconcile reuses the SAME cached object reference for the unchanged group.
    const next = reconcileHierarchicalLayout(prev, world(), keyFor);
    expect(next.activeKey.get("A")).toEqual(keyA);
    expect(next.cache.get("A", keyA)).toBe(cachedA);
  });

  // ── Regression group: the reuse test must mean "this group's CONTENTS are unchanged", not
  // merely "the scene material is unchanged". See `GroupKeyFn` (scene-hierarchical-layout.ts) for
  // the full rationale; each test below names the transition it pins.

  test("a group that GAINS members re-decomposes; its new children are positioned", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);

    // The cut refined a nested subgroup inside A: same material, same box key, but A now owns two
    // MORE nodes. A must re-decompose so the new children get real positions.
    const refined: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 20, y: 20 }],
        ["A/f2", { x: 20, y: 140 }],
        ["A/f3", { x: 200, y: 20 }],
        ["A/f4", { x: 200, y: 140 }],
        // B's fresh coordinates are PERTURBED (membership unchanged), so the assertions below
        // hold only if B's cached local layout was reused — with B's prior coordinates they would
        // have passed under reuse and re-decompose alike.
        ["B/f1", { x: 1300, y: 250 }],
        ["B/f2", { x: 1100, y: 60 }],
        ["orphan", { x: 5000, y: 5000 }],
      ]),
      clusters: [box("A", 0, 0), box("B", 1000, 0)],
    };
    const next = reconcileHierarchicalLayout(prev, refined, keyFor);
    const s = worldScene(next);
    // The newly revealed children are positioned — NOT missing (which renders them at 0,0).
    expect(s.positions.get("A/f3")).toEqual({ x: 200, y: 20 });
    expect(s.positions.get("A/f4")).toEqual({ x: 200, y: 140 });
    // B is untouched material AND untouched contents → reuse wins over the fresh coordinates.
    expect(s.positions.get("B/f1")).toEqual({ x: 1020, y: 20 });
    expect(s.positions.get("B/f2")).toEqual({ x: 1020, y: 140 });
  });

  test("a group folding into the ungrouped remainder positions its new proxy card", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);

    // Zoom out: group B folded, so its box is gone and it is now a single aggregate proxy CARD
    // sitting outside every top-level box — i.e. it lands in the ungrouped remainder, whose box
    // key already existed. That is exactly the case the old key could not distinguish.
    const folded: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 20, y: 20 }],
        ["A/f2", { x: 20, y: 140 }],
        ["B:proxy", { x: 1200, y: 60 }],
        ["orphan", { x: 5000, y: 5000 }],
      ]),
      clusters: [box("A", 0, 0)],
    };
    const next = reconcileHierarchicalLayout(prev, folded, keyFor);
    const s = worldScene(next);
    expect(s.positions.get("B:proxy")).toEqual({ x: 1200, y: 60 });
  });

  test("a group whose members are merely REORDERED still reuses its cached layout", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);
    const before = snap(prev);

    // Same membership, different worker emission order + different coordinates. The digest is
    // order-independent, so this must stay a HIT — reordering is not a content change, and
    // treating it as one would force a pointless re-decompose on every recut.
    const reordered: WorldLayoutResult = {
      positions: new Map([
        ["A/f2", { x: 77, y: 77 }],
        ["A/f1", { x: 88, y: 88 }],
        ["B/f2", { x: 1077, y: 77 }],
        ["B/f1", { x: 1088, y: 88 }],
        ["orphan", { x: 9999, y: 9999 }],
      ]),
      clusters: [box("B", 1000, 0), box("A", 0, 0)],
    };
    expect(snap(reconcileHierarchicalLayout(prev, reordered, keyFor))).toEqual(before);
  });

  test("a group that SWAPS one member for another (same count) re-decomposes", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);

    // Same member COUNT, different ids — a length-only digest would miss this.
    const swapped: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 20, y: 20 }],
        ["A/f9", { x: 20, y: 140 }],
        ["B/f1", { x: 1020, y: 20 }],
        ["B/f2", { x: 1020, y: 140 }],
        ["orphan", { x: 5000, y: 5000 }],
      ]),
      clusters: [box("A", 0, 0), box("B", 1000, 0)],
    };
    const s = worldScene(reconcileHierarchicalLayout(prev, swapped, keyFor));
    expect(s.positions.get("A/f9")).toEqual({ x: 20, y: 140 });
  });

  test("the cache stays bounded by box-key count across many changed-membership recuts", () => {
    // Regression: once the content digest entered the key, a group's key MOVED whenever its
    // membership moved, so `makeHierarchicalLayout`'s unconditional `cache.set` appended a new
    // permanent entry per changed group per recut. The live path's cache is a bare Map with no LRU
    // (makeLocalLayoutCache), so this grew without bound — measured at 201 entries for 2 box keys
    // over 200 recuts. Every superseded entry is unreachable too: reuse only ever compares against
    // `prev.activeKey`, the immediately preceding key, so no historical entry can be served again.
    const keyFor = groupKeyFromMaterial(material());
    // Each recut the ungrouped remainder gains one more proxy card — the steady-exploration shape.
    const worldAt = (n: number): WorldLayoutResult => {
      const positions = new Map([["A/f1", { x: 20, y: 20 }]]);
      for (let i = 0; i < n; i++) positions.set(`proxy${i}`, { x: 5000 + i, y: 5000 });
      return { positions, clusters: [box("A", 0, 0)] };
    };
    let layout = buildHierarchicalLayoutFromWorld(worldAt(1), keyFor);
    for (let n = 2; n <= 200; n++) layout = reconcileHierarchicalLayout(layout, worldAt(n), keyFor);
    // One live entry per distinct box key (here: "A" + the ungrouped remainder).
    expect(layout.order.length).toBe(2);
    expect(layout.cache.size).toBe(2);
  });

  test("a box key that vanishes from the partition drops its cache entry", () => {
    const keyFor = groupKeyFromMaterial(material());
    const prev = buildHierarchicalLayoutFromWorld(world(), keyFor);
    expect(prev.cache.size).toBe(3); // A, B, ungrouped
    // Group B folds away entirely: its box is gone and its members leave with it.
    const folded: WorldLayoutResult = {
      positions: new Map([
        ["A/f1", { x: 20, y: 20 }],
        ["A/f2", { x: 20, y: 140 }],
        ["orphan", { x: 5000, y: 5000 }],
      ]),
      clusters: [box("A", 0, 0)],
    };
    const next = reconcileHierarchicalLayout(prev, folded, keyFor);
    // B is gone from the layout AND from the cache — `consider` never runs for a vanished box key,
    // so without an explicit drop nothing would ever overwrite or evict its entry.
    expect(next.order).not.toContain("B");
    expect(next.cache.size).toBe(2);
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
