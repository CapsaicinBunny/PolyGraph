// P0.5 "subdivision-strategies" probe — design B1 strategy sequence + impl note (c). Unit
// coverage of the PURE partitioner: community → heavy-edge → directory → balanced-chunk, the
// balance/fan-out validation that REJECTS degenerate splits, and the depth/work-budget bail.

import { describe, expect, test } from "bun:test";
import { MAX_FANOUT } from "./representation";
import {
  balancedChunks,
  type SubdivisionEdge,
  type SubdivisionItem,
  SUBDIVISION_THRESHOLDS,
  SUBDIVISION_VERSION,
  subdivideOnce,
} from "./representation-subdivision";

/** N items, each a singleton leaf (leafWeight 1), repId == index, optional path per item. */
function items(n: number, paths: (i: number) => string = () => ""): SubdivisionItem[] {
  return Array.from({ length: n }, (_, i) => ({ repId: i, leafWeight: 1, pathPrefix: paths(i) }));
}

/** Every item appears exactly once across all buckets (a valid partition). */
function isPartition(buckets: number[][], n: number): boolean {
  const seen = new Set<number>();
  for (const b of buckets) for (const i of b) seen.add(i);
  if (seen.size !== n) return false;
  let total = 0;
  for (const b of buckets) total += b.length;
  return total === n;
}

describe("balancedChunks — the always-available fallback (B1 source 4)", () => {
  test("contiguous chunks of ≤ maxFanout, canonical order preserved", () => {
    const buckets = balancedChunks(70, MAX_FANOUT);
    expect(buckets.length).toBe(Math.ceil(70 / MAX_FANOUT));
    for (const b of buckets) expect(b.length).toBeLessThanOrEqual(MAX_FANOUT);
    expect(isPartition(buckets, 70)).toBe(true);
    // Contiguous + ordered.
    expect(buckets[0][0]).toBe(0);
    expect(buckets[0][MAX_FANOUT - 1]).toBe(MAX_FANOUT - 1);
  });

  test("an exact multiple yields full chunks; a remainder yields a short tail", () => {
    expect(balancedChunks(MAX_FANOUT * 2, MAX_FANOUT).length).toBe(2);
    const rem = balancedChunks(MAX_FANOUT + 1, MAX_FANOUT);
    expect(rem.length).toBe(2);
    expect(rem[1].length).toBe(1);
  });
});

describe("strategy (1): community partitioning of a WELL-CLUSTERED group", () => {
  // Two tight cliques (0-1-2 and 3-4-5) joined by a single weak bridge. A well-clustered group:
  // community detection should recover the two clusters as two buckets.
  const its = items(6);
  const edges: SubdivisionEdge[] = [
    { a: 0, b: 1, weight: 1 },
    { a: 1, b: 2, weight: 1 },
    { a: 0, b: 2, weight: 1 },
    { a: 3, b: 4, weight: 1 },
    { a: 4, b: 5, weight: 1 },
    { a: 3, b: 5, weight: 1 },
    { a: 2, b: 3, weight: 1 }, // the single bridge between the cliques
  ];

  test("a well-clustered group gets a community partition (≥2 balanced buckets)", () => {
    const res = subdivideOnce(its, edges, MAX_FANOUT);
    expect(res.strategy).toBe("community");
    expect(res.buckets.length).toBeGreaterThanOrEqual(2);
    expect(isPartition(res.buckets, 6)).toBe(true);
    // The two cliques are NOT split across the same bucket pair — each clique stays together.
    const bucketOf = new Map<number, number>();
    res.buckets.forEach((b, bi) => b.forEach((i) => bucketOf.set(i, bi)));
    expect(bucketOf.get(0)).toBe(bucketOf.get(1));
    expect(bucketOf.get(1)).toBe(bucketOf.get(2));
    expect(bucketOf.get(3)).toBe(bucketOf.get(4));
    expect(bucketOf.get(4)).toBe(bucketOf.get(5));
    expect(bucketOf.get(0)).not.toBe(bucketOf.get(3));
  });

  test("buckets are deterministic across repeated runs", () => {
    const a = subdivideOnce(its, edges, MAX_FANOUT);
    const b = subdivideOnce(its, edges, MAX_FANOUT);
    expect(a.buckets).toEqual(b.buckets);
  });

  test("no edges → community is skipped (falls through to chunk)", () => {
    const res = subdivideOnce(items(50), [], MAX_FANOUT);
    expect(res.strategy).toBe("chunk");
  });
});

describe("strategy (1) REJECTED degenerate partition → falls through (impl note c)", () => {
  // A STAR: one hub (item 0) connected to many leaves, with the leaves pairwise unconnected.
  // Label-propagation collapses the whole star into ONE community (everyone adopts the hub's
  // label) → a single dominant bucket. That must be REJECTED for balance and fall through.
  test("a star collapsing to one community is rejected; a later strategy wins", () => {
    const n = 40;
    const its = items(n);
    const edges: SubdivisionEdge[] = [];
    for (let i = 1; i < n; i++) edges.push({ a: 0, b: i, weight: 1 });
    const res = subdivideOnce(its, edges, MAX_FANOUT);
    // NOT community — the one-giant-bucket split was rejected. Heavy-edge matching (hub matches
    // one leaf, the rest pair up / singleton) gives a balanced split, else chunk.
    expect(res.strategy).not.toBe("community");
    expect(isPartition(res.buckets, n)).toBe(true);
    // Whatever won, no bucket dominates.
    const total = n;
    for (const b of res.buckets) {
      expect(b.length).toBeLessThanOrEqual(
        total * SUBDIVISION_THRESHOLDS.maxDominantWeightFraction,
      );
    }
  });

  test("an explicitly dominant community (one weight-heavy bucket) is rejected on weight", () => {
    // 31 items: 0..29 form one dense clique (all interconnected) and 30 is a lone singleton with
    // no edge. The clique is >85% of the weight → dominant → community rejected.
    const its = items(31);
    const edges: SubdivisionEdge[] = [];
    for (let i = 0; i < 30; i++)
      for (let j = i + 1; j < 30; j++) edges.push({ a: i, b: j, weight: 1 });
    const res = subdivideOnce(its, edges, MAX_FANOUT);
    expect(res.strategy).not.toBe("community");
    expect(isPartition(res.buckets, 31)).toBe(true);
  });
});

describe("strategy (3): directory subdivision when a path prefix is available", () => {
  // No edges (so community/heavy-edge skip), but every item has a path under a shared root.
  // Files split by their subdirectory below the common prefix.
  test("items split by next path segment below the common prefix", () => {
    const paths = (i: number) => {
      if (i < 20) return `src/alpha/f${i}.ts`;
      if (i < 40) return `src/beta/f${i}.ts`;
      return `src/gamma/f${i}.ts`;
    };
    const res = subdivideOnce(items(60, paths), [], MAX_FANOUT);
    expect(res.strategy).toBe("directory");
    expect(res.buckets.length).toBe(3); // alpha / beta / gamma
    expect(isPartition(res.buckets, 60)).toBe(true);
    // Items in the same subdir share a bucket.
    const bucketOf = new Map<number, number>();
    res.buckets.forEach((b, bi) => b.forEach((i) => bucketOf.set(i, bi)));
    expect(bucketOf.get(0)).toBe(bucketOf.get(19));
    expect(bucketOf.get(20)).toBe(bucketOf.get(39));
    expect(bucketOf.get(0)).not.toBe(bucketOf.get(20));
  });

  test("all items in one directory → no structure → directory skipped, chunk wins", () => {
    const res = subdivideOnce(
      items(50, (i) => `src/one/f${i}.ts`),
      [],
      MAX_FANOUT,
    );
    expect(res.strategy).toBe("chunk");
  });

  test("a directory split that is one-huge-+-tiny is rejected (balance)", () => {
    // 49 files in src/big, 1 file in src/tiny → big is 98% → dominant → rejected → chunk.
    const paths = (i: number) => (i < 49 ? `src/big/f${i}.ts` : `src/tiny/f${i}.ts`);
    const res = subdivideOnce(items(50, paths), [], MAX_FANOUT);
    expect(res.strategy).toBe("chunk");
  });
});

describe("depth/work bail (impl note c): MAX_PARTITION_WORK_MS exceeded → chunks", () => {
  test("a passed deadline skips the smart strategies and chunks immediately", () => {
    // Well-clustered (community WOULD win) but the clock is already past the deadline.
    const its = items(6);
    const edges: SubdivisionEdge[] = [
      { a: 0, b: 1, weight: 1 },
      { a: 1, b: 2, weight: 1 },
      { a: 3, b: 4, weight: 1 },
      { a: 4, b: 5, weight: 1 },
      { a: 2, b: 3, weight: 1 },
    ];
    const clock = () => 1000; // now=1000
    const res = subdivideOnce(its, edges, MAX_FANOUT, /* deadline */ 500, clock);
    expect(res.strategy).toBe("chunk");
    expect(isPartition(res.buckets, 6)).toBe(true);
  });

  test("a deadline in the future still runs the smart strategies", () => {
    const its = items(6);
    const edges: SubdivisionEdge[] = [
      { a: 0, b: 1, weight: 1 },
      { a: 1, b: 2, weight: 1 },
      { a: 0, b: 2, weight: 1 },
      { a: 3, b: 4, weight: 1 },
      { a: 4, b: 5, weight: 1 },
      { a: 3, b: 5, weight: 1 },
      { a: 2, b: 3, weight: 1 },
    ];
    const res = subdivideOnce(its, edges, MAX_FANOUT, /* deadline */ 10_000, () => 0);
    expect(res.strategy).toBe("community");
  });
});

describe("SUBDIVISION_VERSION folds the strategy + thresholds", () => {
  test("is a non-empty string that mentions the dominant-weight threshold", () => {
    expect(typeof SUBDIVISION_VERSION).toBe("string");
    expect(SUBDIVISION_VERSION.length).toBeGreaterThan(0);
    expect(SUBDIVISION_VERSION).toContain(String(SUBDIVISION_THRESHOLDS.maxDominantWeightFraction));
  });
});
