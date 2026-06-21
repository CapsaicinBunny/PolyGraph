import { describe, expect, test } from "bun:test";
import {
  type CachedLocalLayout,
  type LocalLayoutCache,
  type ProxyCacheKey,
  localToWorld,
  makeLocalLayoutCache,
  proxyCacheKeyEquals,
  serializeProxyCacheKey,
} from "./local-layout";

// A baseline cache key; individual tests vary exactly one part to prove that part
// participates in cache identity (the spec's "changing direction, card metrics, edge
// filters, or grouping semantics invalidates it" — Appendix A §H).
const baseKey: ProxyCacheKey = {
  graphVersion: "g1",
  filterSignature: "f1",
  groupingMode: "directory",
  groupingVersion: "gv1",
  layoutEngine: "smart",
  layoutDirection: "TB",
  layoutOptionsHash: "lo1",
  nodeStyleMetricsVersion: "nm1",
  edgeKindsSignature: "ek1",
  representationId: 7,
  representationBuilderVersion: "rb1",
};

const localLayout = (): CachedLocalLayout => ({
  positions: new Map([
    ["n1", { x: 10, y: 20 }],
    ["n2", { x: 30, y: 40 }],
  ]),
  clusters: [{ id: "g/sub", x: 5, y: 5, width: 100, height: 80, depth: 1, label: "sub" }],
  width: 200,
  height: 160,
});

describe("ProxyCacheKey — every part participates in identity (Appendix A §H)", () => {
  const parts: (keyof ProxyCacheKey)[] = [
    "graphVersion",
    "filterSignature",
    "groupingMode",
    "groupingVersion",
    "layoutEngine",
    "layoutDirection",
    "layoutOptionsHash",
    "nodeStyleMetricsVersion",
    "edgeKindsSignature",
    "representationId",
    "representationBuilderVersion",
  ];

  test("an identical key compares equal and serializes identically", () => {
    const copy: ProxyCacheKey = { ...baseKey };
    expect(proxyCacheKeyEquals(baseKey, copy)).toBe(true);
    expect(serializeProxyCacheKey(baseKey)).toBe(serializeProxyCacheKey(copy));
  });

  for (const part of parts) {
    test(`changing ${part} makes the key differ (cache miss)`, () => {
      const changed: ProxyCacheKey = { ...baseKey };
      // Vary the one part (numeric for representationId, string otherwise).
      if (part === "representationId") changed.representationId = baseKey.representationId + 1;
      else (changed[part] as string) = `${baseKey[part]}-X`;
      expect(proxyCacheKeyEquals(baseKey, changed)).toBe(false);
      expect(serializeProxyCacheKey(baseKey)).not.toBe(serializeProxyCacheKey(changed));
    });
  }

  test("serialization is canonical regardless of object property insertion order", () => {
    // Build a key with the SAME values but inserted in a scrambled order.
    const scrambled = {} as ProxyCacheKey;
    scrambled.representationBuilderVersion = baseKey.representationBuilderVersion;
    scrambled.representationId = baseKey.representationId;
    scrambled.edgeKindsSignature = baseKey.edgeKindsSignature;
    scrambled.nodeStyleMetricsVersion = baseKey.nodeStyleMetricsVersion;
    scrambled.layoutOptionsHash = baseKey.layoutOptionsHash;
    scrambled.layoutDirection = baseKey.layoutDirection;
    scrambled.layoutEngine = baseKey.layoutEngine;
    scrambled.groupingVersion = baseKey.groupingVersion;
    scrambled.groupingMode = baseKey.groupingMode;
    scrambled.filterSignature = baseKey.filterSignature;
    scrambled.graphVersion = baseKey.graphVersion;
    expect(serializeProxyCacheKey(scrambled)).toBe(serializeProxyCacheKey(baseKey));
  });
});

describe("LocalLayoutCache — hit/miss keyed by (group, ProxyCacheKey)", () => {
  test("get returns undefined on a cold cache (miss), the stored layout after set (hit)", () => {
    const cache: LocalLayoutCache = makeLocalLayoutCache();
    expect(cache.get("g", baseKey)).toBeUndefined();
    const ll = localLayout();
    cache.set("g", baseKey, ll);
    expect(cache.get("g", baseKey)).toBe(ll);
    expect(cache.size).toBe(1);
  });

  test("a different group is a miss (same key, different reserved box owner)", () => {
    const cache = makeLocalLayoutCache();
    cache.set("g", baseKey, localLayout());
    expect(cache.get("h", baseKey)).toBeUndefined();
  });

  test("a direction change invalidates the entry (miss) — same group", () => {
    const cache = makeLocalLayoutCache();
    cache.set("g", baseKey, localLayout());
    const flipped: ProxyCacheKey = { ...baseKey, layoutDirection: "LR" };
    expect(cache.get("g", flipped)).toBeUndefined();
  });

  test("a node-style-metrics version change invalidates the entry (miss)", () => {
    const cache = makeLocalLayoutCache();
    cache.set("g", baseKey, localLayout());
    const remetered: ProxyCacheKey = { ...baseKey, nodeStyleMetricsVersion: "nm2" };
    expect(cache.get("g", remetered)).toBeUndefined();
  });

  test("a filter-signature change invalidates the entry (miss)", () => {
    const cache = makeLocalLayoutCache();
    cache.set("g", baseKey, localLayout());
    const refiltered: ProxyCacheKey = { ...baseKey, filterSignature: "f2" };
    expect(cache.get("g", refiltered)).toBeUndefined();
  });

  test("overwriting the same (group,key) replaces the entry without growing size", () => {
    const cache = makeLocalLayoutCache();
    cache.set("g", baseKey, localLayout());
    const replacement = localLayout();
    cache.set("g", baseKey, replacement);
    expect(cache.get("g", baseKey)).toBe(replacement);
    expect(cache.size).toBe(1);
  });
});

describe("localToWorld — a cached local layout offsets into its reserved box origin", () => {
  test("child positions + cluster boxes shift by the reserved box origin", () => {
    const ll = localLayout();
    const world = localToWorld(ll, { x: 1000, y: 500 });
    // Each node's local coord is offset by the box origin (parent-space → world-space).
    expect(world.positions.get("n1")).toEqual({ x: 1010, y: 520 });
    expect(world.positions.get("n2")).toEqual({ x: 1030, y: 540 });
    // Nested cluster boxes shift too.
    expect(world.clusters[0]).toMatchObject({ id: "g/sub", x: 1005, y: 505 });
    // Size is intrinsic to the local layout — the offset does not change it.
    expect(world.clusters[0]).toMatchObject({ width: 100, height: 80 });
  });

  test("a zero origin is the identity (local IS world when the box sits at the origin)", () => {
    const ll = localLayout();
    const world = localToWorld(ll, { x: 0, y: 0 });
    expect(world.positions.get("n1")).toEqual({ x: 10, y: 20 });
    expect(world.clusters[0]).toMatchObject({ x: 5, y: 5 });
  });

  test("the source local layout is not mutated (a pure projection)", () => {
    const ll = localLayout();
    localToWorld(ll, { x: 1000, y: 500 });
    // The original local coordinates are untouched.
    expect(ll.positions.get("n1")).toEqual({ x: 10, y: 20 });
    expect(ll.clusters[0]).toMatchObject({ x: 5, y: 5 });
  });
});
