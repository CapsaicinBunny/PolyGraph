// The SINGLE atomic readiness policy (design B3 + impl note (d)). Proves:
//   - COARSEN-IMMEDIATE vs REFINE-CACHE-MISS-RETAIN: a fold commits immediately (no async), a
//     refine whose local layout is cached commits immediately, a refine whose layout is a cache
//     MISS retains the proxy and emits a generation-tagged async request.
//   - STALE GENERATION discarded: a result whose generation ≠ the live target is dropped.
//   - CANCELLATION: advancing the live generation cancels every older in-flight request, and a
//     late result for a cancelled request is judged "cancelled" (never committed).
//   - The bounded local-layout cache enforces an entry + byte LRU cap.

import { describe, expect, test } from "bun:test";
import {
  BoundedLayoutCache,
  classifyTransition,
  estimateLayoutBytes,
  type LayoutCacheKey,
  planTransition,
  ReadinessController,
} from "./readiness";
import type { CachedLocalLayout } from "./local-layout";
import type { CutDiff } from "./proxy-materialize";

// A trivial cached layout of a given node-count (sizes the byte estimate for the cap tests).
const layout = (nodes = 1): CachedLocalLayout => ({
  positions: new Map(Array.from({ length: nodes }, (_, i) => [`n${i}`, { x: i, y: i }])),
  clusters: [],
  width: 100,
  height: 100,
});

// A diff helper: `refined` = proxies that OPENED (need a layout), `coarsened` = proxies that
// FOLDED (need none). `unchanged` is irrelevant to readiness.
const diff = (refined: number[], coarsened: number[]): CutDiff => ({
  refined: Uint32Array.from(refined),
  coarsened: Uint32Array.from(coarsened),
  unchanged: new Uint32Array(0),
});

// The cache key for a root is just its rep id as a string here (the readiness layer treats keys
// as opaque; the live path serializes a (boxKey, ProxyCacheKey)).
const keyOf = (root: number): LayoutCacheKey => `rep:${root}`;

describe("classifyTransition / planTransition — coarsen-immediate vs refine-cache-miss-retain", () => {
  test("a coarsen (fold) is ALWAYS immediate — no async layout (impl note d)", () => {
    const cache = new BoundedLayoutCache();
    const plan = planTransition(diff([], [7, 3]), cache, keyOf, 5);
    expect(plan.immediateRoots).toEqual([3, 7]); // both folds commit now
    expect(plan.pendingRoots).toEqual([]);
    expect(plan.requests).toEqual([]);
  });

  test("a refine with a cache HIT is immediate; a cache MISS retains + requests async", () => {
    const cache = new BoundedLayoutCache();
    cache.set(keyOf(10), layout()); // rep 10's local layout is cached → HIT
    // rep 20 has no cached layout → MISS.
    const plan = planTransition(diff([10, 20], []), cache, keyOf, 9);
    expect(plan.immediateRoots).toEqual([10]); // the HIT commits immediately
    expect(plan.pendingRoots).toEqual([20]); // the MISS retains its proxy, waits on async
    expect(plan.requests).toEqual([{ root: 20, cacheKey: keyOf(20), targetGeneration: 9 }]);
  });

  test("classification is the union: coarsen first, then refined, each ascending + tagged HIT/MISS", () => {
    const cache = new BoundedLayoutCache();
    cache.set(keyOf(2), layout());
    const c = classifyTransition(diff([5, 2], [8]), cache, keyOf);
    expect(c).toEqual([
      { root: 8, disposition: "coarsen", cacheKey: keyOf(8) },
      { root: 2, disposition: "refine-hit", cacheKey: keyOf(2) },
      { root: 5, disposition: "refine-miss", cacheKey: keyOf(5) },
    ]);
  });

  test("planTransition mutates nothing — the cache is unchanged after planning", () => {
    const cache = new BoundedLayoutCache();
    cache.set(keyOf(1), layout());
    const before = cache.size;
    planTransition(diff([1, 2], [3]), cache, keyOf, 1);
    expect(cache.size).toBe(before);
    expect(cache.has(keyOf(2))).toBe(false); // a miss did not get inserted by planning
  });
});

describe("ReadinessController — stale generation discarded (B3 rule 6)", () => {
  test("a result tagged with the live generation is ACCEPTED", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(3);
    rc.track(20, 3);
    expect(rc.resolve(20, 3)).toBe("accept");
    expect(rc.pendingCount).toBe(0);
  });

  test("an in-flight request superseded by a newer generation is DISCARDED (never accepted)", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(3);
    rc.track(20, 3);
    // The cut moves on to generation 4 (a fresh solve) BEFORE the gen-3 layout returns. The
    // controller proactively cancelled the obsolete request, so the late result is "cancelled" —
    // either way it is DISCARDED (B3 rule 6: a non-live generation never commits).
    rc.beginGeneration(4);
    expect(rc.resolve(20, 3)).not.toBe("accept");
  });

  test("a stale-tagged result for a still-tracked root (no cancel) reports stale-generation", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(3);
    rc.track(20, 3);
    // A duplicate/late result tagged with an OLD generation arrives while the gen-3 request is
    // still tracked and live — it was never cancelled, so it is plainly stale (not "cancelled").
    expect(rc.resolve(20, 2)).toBe("stale-generation");
    // The live gen-3 request survives that stale drop and can still be accepted.
    expect(rc.resolve(20, 3)).toBe("accept");
  });

  test("a result tagged NEWER than the live target is also stale (never committed early)", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(2);
    rc.track(5, 2);
    expect(rc.resolve(5, 7)).toBe("stale-generation");
  });

  test("an untracked root (never requested) is stale, not accepted", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(1);
    expect(rc.resolve(99, 1)).toBe("stale-generation");
  });
});

describe("ReadinessController — cancellation of obsolete requests (P3)", () => {
  test("advancing the generation CANCELS every older in-flight request", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(1);
    rc.track(10, 1);
    rc.track(11, 1);
    // A newer target supersedes generation 1 → both gen-1 requests are obsolete.
    const cancelled = rc.beginGeneration(2);
    expect(cancelled).toEqual([10, 11]);
    expect(rc.pendingCount).toBe(0);
  });

  test("a late result for a cancelled request is judged 'cancelled', never committed", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(1);
    rc.track(10, 1);
    rc.beginGeneration(2); // cancels rep 10's request
    expect(rc.resolve(10, 1)).toBe("cancelled");
  });

  test("a request at the new generation survives a generation advance to the SAME generation", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(2);
    rc.track(10, 2);
    expect(rc.beginGeneration(2)).toEqual([]); // no older request to cancel
    expect(rc.resolve(10, 2)).toBe("accept");
  });

  test("a fresh request for a previously-cancelled root un-cancels it", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(1);
    rc.track(10, 1);
    rc.beginGeneration(2); // cancels rep 10 @ gen 1
    rc.track(10, 2); // re-request rep 10 at the live generation
    expect(rc.resolve(10, 2)).toBe("accept");
  });

  test("beginGeneration ignores a stale (lower) generation argument", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(5);
    expect(rc.beginGeneration(3)).toEqual([]); // monotonic — no regress
    expect(rc.generation).toBe(5);
  });

  test("reset forgets all tracking", () => {
    const rc = new ReadinessController();
    rc.beginGeneration(1);
    rc.track(10, 1);
    rc.reset();
    expect(rc.pendingCount).toBe(0);
    expect(rc.resolve(10, 1)).toBe("stale-generation");
  });
});

describe("BoundedLayoutCache — LRU + memory cap (P3 'cache memory limit / LRU')", () => {
  test("evicts the least-recently-used entry past the entry cap", () => {
    const cache = new BoundedLayoutCache(2);
    cache.set("a", layout());
    cache.set("b", layout());
    cache.get("a"); // touch a → b is now LRU
    cache.set("c", layout()); // over the cap of 2 → evict b
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  test("a HIT promotes to most-recently-used (a probe via has() does NOT)", () => {
    const cache = new BoundedLayoutCache(2);
    cache.set("a", layout());
    cache.set("b", layout());
    cache.has("a"); // probe — does not promote
    cache.set("c", layout()); // evicts the true LRU (a)
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  test("enforces the BYTE cap, evicting until the footprint fits", () => {
    // ~ each 100-node layout ≈ 64 + 100*40 = 4064 bytes. Cap at ~9000 → holds 2, not 3.
    const cache = new BoundedLayoutCache(100, 9000);
    cache.set("a", layout(100));
    cache.set("b", layout(100));
    cache.set("c", layout(100));
    expect(cache.has("a")).toBe(false); // LRU evicted to fit the byte cap
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.byteSize).toBeLessThanOrEqual(9000);
  });

  test("never evicts the sole just-set entry even if it alone exceeds the cap", () => {
    const cache = new BoundedLayoutCache(100, 100);
    cache.set("big", layout(100)); // ~4064 bytes, over the 100B cap, but it's the only entry
    expect(cache.has("big")).toBe(true);
  });

  test("estimateLayoutBytes is monotone in node + cluster count", () => {
    expect(estimateLayoutBytes(layout(10))).toBeGreaterThan(estimateLayoutBytes(layout(1)));
  });

  test("delete drops an entry and reclaims its bytes; clear empties the cache", () => {
    const cache = new BoundedLayoutCache();
    cache.set("a", layout(50));
    const b = cache.byteSize;
    expect(b).toBeGreaterThan(0);
    cache.delete("a");
    expect(cache.has("a")).toBe(false);
    expect(cache.byteSize).toBe(0);
    cache.set("x", layout());
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
