// Subdivision strategies for intermediate render-only proxy tiers (design B1 source 1-4 +
// impl note (c)). The representation builder inserts a bounded tree of render-only proxies
// between an OVERSIZED semantic group rep and its children (leaves + child-group reps) so
// refinement has bounded intermediate antichains to land on (design B1 "the biggest gap").
//
// HOW the children are grouped into the next tier is what this module decides. Impl note (c)
// pins a STRATEGY SEQUENCE, tried in order, AHEAD of the always-available balanced-chunk
// fallback:
//
//   (1) recursive COMMUNITY partitioning of the group's induced subgraph (reuse the existing
//       community detector on the in-group edges);
//   (2) HEAVY-EDGE / matching graph coarsening where community partitioning is degenerate;
//   (3) DIRECTORY subdivision where a path prefix is available for the members;
//   (4) DETERMINISTIC BALANCED CHUNKS — the always-available fallback that GUARANTEES the
//       invariants.
//
// After each strategy we VALIDATE balance + fan-out: a partition that is "one huge bucket +
// several tiny ones" (the classic community-detection degeneracy) is REJECTED and we fall
// through to the next strategy. The whole pass respects {@link MAX_PARTITION_DEPTH} and bails
// to balanced chunks if {@link MAX_PARTITION_WORK_MS} is exceeded — so subdivision can never
// itself become an unbounded cost (design Risks: "subdivision must itself be incremental /
// cached … or P0.5 reintroduces the per-recut O(N)").
//
// This module is PURE and deterministic: it takes the child items + optional in-group edges +
// optional path prefixes and returns a partition (buckets of item indices). It knows nothing
// about rep ids, columnar arrays, or the snapshot — the builder maps item indices back to rep
// ids. Pure; no React, no GPU.

import { detectCommunities } from "../layout/community";

/**
 * An item to be partitioned: one direct child of an oversized parent rep (a leaf rep or a
 * child-group rep). `leafWeight` is the number of underlying leaves the item stands in for
 * (1 for a leaf rep; its subtree leaf count for a child-group rep) — used for BALANCE
 * validation so a "one huge subgroup + many singletons" split is judged on real size, not
 * item count. `pathPrefix` is the item's directory path (or "" when unavailable), used only
 * by the directory strategy.
 */
export interface SubdivisionItem {
  /** Stable item id (the underlying rep id; the strategies only use it for determinism ties). */
  repId: number;
  /** Underlying leaf count this item represents (≥ 1). */
  leafWeight: number;
  /** Directory path prefix of the item, or "" when no path is available. */
  pathPrefix: string;
}

/**
 * An undirected weighted edge BETWEEN two items, by item index (`a`/`b` index into the
 * `items` array). Self-loops (a === b) and out-of-range endpoints are ignored. Weight is the
 * aggregated edge count between the two items' subtrees (defaults to 1 per edge).
 */
export interface SubdivisionEdge {
  a: number;
  b: number;
  weight: number;
}

/** The algorithm that produced a partition — folded into the builder version (impl note c). */
export type SubdivisionStrategy = "community" | "heavy-edge" | "directory" | "chunk";

/**
 * The thresholds that gate strategy acceptance. Folded (with the chosen strategy id) into
 * {@link SUBDIVISION_VERSION} so a tuning change invalidates proxy caches (impl note c —
 * "Include the partition algorithm + thresholds in `representationBuilderVersion`").
 */
export const SUBDIVISION_THRESHOLDS = {
  /**
   * A partition must split the items into AT LEAST this many buckets to be useful — a single
   * bucket holding everything makes no progress (it just re-wraps the whole oversized set).
   */
  minBuckets: 2,
  /**
   * BALANCE rejection (the impl-note (c) "one huge + several tiny" degeneracy). A partition is
   * rejected when its LARGEST bucket holds more than this fraction of the total leaf weight
   * AND there is more than one bucket — i.e. a dominant bucket that barely subdivided anything.
   * 0.85 → a bucket holding >85% of the weight while ≥1 other tiny bucket exists is degenerate.
   */
  maxDominantWeightFraction: 0.85,
  /**
   * A heavy-edge matching is only accepted when it actually CONTRACTED enough — at least this
   * fraction of items must have been matched into a partner (else it degrades to near-identity,
   * making no real coarsening progress and we fall to directory/chunk).
   */
  minMatchedFraction: 0.25,
} as const;

/**
 * Version tag of the subdivision strategy + thresholds. Concatenated into the representation
 * builder version (and thence the material signature) so a change to the strategy sequence or
 * any threshold invalidates the cached runtime + downstream proxy caches (impl note c). The
 * fan-out bound ({@link MAX_FANOUT}) lives in `representation.ts` and is folded into the builder
 * version alongside this tag there, so it is intentionally NOT repeated here (and keeping it out
 * avoids a circular module dependency between the builder and this pure partitioner).
 */
export const SUBDIVISION_VERSION = [
  "sd1",
  `mb=${SUBDIVISION_THRESHOLDS.minBuckets}`,
  `dw=${SUBDIVISION_THRESHOLDS.maxDominantWeightFraction}`,
  `mm=${SUBDIVISION_THRESHOLDS.minMatchedFraction}`,
].join(",");

/** The result of subdividing one oversized parent's children once. */
export interface SubdivisionResult {
  /** Buckets of item INDICES (into the `items` array). Every index appears exactly once. */
  buckets: number[][];
  /** Which strategy produced these buckets (for diagnostics + the version fold). */
  strategy: SubdivisionStrategy;
}

/** A monotonic-clock reader, injectable so tests can drive the work-budget bail deterministically. */
export type Clock = () => number;

const defaultClock: Clock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Subdivide one oversized parent's direct children into a partition of buckets, trying the
 * strategy sequence (community → heavy-edge → directory → chunk) and validating balance +
 * fan-out after each. Returns the FIRST accepted partition; the balanced-chunk fallback is
 * always accepted, so a result is always returned.
 *
 * `maxFanout` is the per-tier chunk size / acceptance bound (the builder passes {@link MAX_FANOUT}).
 * `deadline` is an absolute clock value (same units as `clock`); when the clock passes it the
 * better strategies are skipped and we go straight to balanced chunks (impl note c — bail to
 * chunks if MAX_PARTITION_WORK_MS is exceeded). `clock` defaults to `performance.now`.
 */
export function subdivideOnce(
  items: readonly SubdivisionItem[],
  edges: readonly SubdivisionEdge[],
  maxFanout: number,
  deadline = Number.POSITIVE_INFINITY,
  clock: Clock = defaultClock,
): SubdivisionResult {
  // Past the work budget → straight to the always-valid fallback. Checked FIRST so an exhausted
  // budget never even attempts the (more expensive) community / matching passes.
  if (clock() < deadline) {
    const community = tryCommunity(items, edges, maxFanout);
    if (community) return { buckets: community, strategy: "community" };

    if (clock() < deadline) {
      const heavy = tryHeavyEdge(items, edges, maxFanout);
      if (heavy) return { buckets: heavy, strategy: "heavy-edge" };
    }

    if (clock() < deadline) {
      const dir = tryDirectory(items, maxFanout);
      if (dir) return { buckets: dir, strategy: "directory" };
    }
  }

  return { buckets: balancedChunks(items.length, maxFanout), strategy: "chunk" };
}

// ── strategy (1): community partitioning ──────────────────────────────────────────

/**
 * Partition items by community over the in-group induced subgraph (design B1 source 1). Reuses
 * the existing {@link detectCommunities} label-propagation detector on the item-level edges.
 * Returns null (→ fall through) when there are no edges, when the detector yields a single
 * community (no structure to exploit), when it produces MORE than `maxFanout` communities (too
 * fragmented to be a single tier — the chunk fallback handles those uniformly), or when the
 * split is degenerate (one dominant bucket — impl note c).
 */
function tryCommunity(
  items: readonly SubdivisionItem[],
  edges: readonly SubdivisionEdge[],
  maxFanout: number,
): number[][] | null {
  if (edges.length === 0) return null;

  // The detector speaks node-id strings; use the item INDEX as the id so the result maps back
  // directly. Isolated items (no edge) still get their own singleton community from the detector.
  const ids = items.map((_, i) => String(i));
  const detectorEdges: { source: string; target: string }[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    if (e.a < 0 || e.a >= items.length || e.b < 0 || e.b >= items.length) continue;
    // detectCommunities dedupes undirected neighbors; weight is folded by repeating the pair
    // up to a small cap so a heavy link votes more without blowing up the edge list.
    const reps = Math.max(1, Math.min(4, Math.round(e.weight)));
    for (let r = 0; r < reps; r++) detectorEdges.push({ source: String(e.a), target: String(e.b) });
  }
  if (detectorEdges.length === 0) return null;

  const communityOf = detectCommunities(ids, detectorEdges);
  const bucketByCommunity = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const c = communityOf.get(String(i)) ?? String(i); // isolated → own community
    let bucket = bucketByCommunity.get(c);
    if (bucket === undefined) bucketByCommunity.set(c, (bucket = []));
    bucket.push(i);
  }
  const buckets = [...bucketByCommunity.values()];
  // One community → no structure. More than maxFanout → too fragmented for one tier (chunking is
  // the deterministic way to coalesce those; community gives no advantage there).
  if (buckets.length < SUBDIVISION_THRESHOLDS.minBuckets) return null;
  if (buckets.length > maxFanout) return null;
  if (!balanceOk(items, buckets)) return null; // REJECT one-huge-+-tiny (impl note c)
  return sortBuckets(items, buckets);
}

// ── strategy (2): heavy-edge / matching coarsening ─────────────────────────────────

/**
 * Coarsen by HEAVY-EDGE matching (design B1 source 2 — "where community partitioning is
 * degenerate"). Classic graph-coarsening: visit items in a deterministic order; match each
 * unmatched item to its heaviest unmatched neighbor; each matched pair (or unmatched singleton)
 * becomes one bucket. Returns null when there are no edges, when too few items actually matched
 * (no real contraction — {@link SUBDIVISION_THRESHOLDS.minMatchedFraction}), when the result
 * still exceeds `maxFanout` buckets, or when the split is degenerate.
 *
 * Unlike community detection (which can collapse a bridged graph into one giant community), a
 * matching contracts AT MOST pairs, so it can never produce the single-dominant-bucket
 * degeneracy on a connected-but-uneven subgraph — which is exactly why it is the fallback when
 * community is rejected.
 */
function tryHeavyEdge(
  items: readonly SubdivisionItem[],
  edges: readonly SubdivisionEdge[],
  maxFanout: number,
): number[][] | null {
  if (edges.length === 0) return null;
  const n = items.length;

  // Adjacency with summed weights (undirected). Map keyed by neighbor index → weight.
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (const e of edges) {
    if (e.a === e.b) continue;
    if (e.a < 0 || e.a >= n || e.b < 0 || e.b >= n) continue;
    adj[e.a].set(e.b, (adj[e.a].get(e.b) ?? 0) + e.weight);
    adj[e.b].set(e.a, (adj[e.b].get(e.a) ?? 0) + e.weight);
  }

  const matchedWith = new Int32Array(n).fill(-1);
  let matchedCount = 0;
  // Deterministic visitation order: ascending item index (items are already in canonical order).
  for (let i = 0; i < n; i++) {
    if (matchedWith[i] !== -1) continue;
    let best = -1;
    let bestWeight = -1;
    // Heaviest unmatched neighbor; ties break to the smallest index for determinism.
    for (const [nb, w] of adj[i]) {
      if (matchedWith[nb] !== -1) continue;
      if (w > bestWeight || (w === bestWeight && nb < best)) {
        best = nb;
        bestWeight = w;
      }
    }
    if (best !== -1) {
      matchedWith[i] = best;
      matchedWith[best] = i;
      matchedCount += 2;
    }
  }

  if (matchedCount < n * SUBDIVISION_THRESHOLDS.minMatchedFraction) return null; // too little contraction

  // Emit one bucket per matched pair / unmatched singleton (each pair emitted once, at its lower index).
  const buckets: number[][] = [];
  for (let i = 0; i < n; i++) {
    const m = matchedWith[i];
    if (m === -1) buckets.push([i]);
    else if (i < m) buckets.push([i, m]);
  }
  if (buckets.length < SUBDIVISION_THRESHOLDS.minBuckets) return null;
  if (buckets.length > maxFanout) return null; // still too wide for one tier — let chunking coalesce
  if (!balanceOk(items, buckets)) return null;
  return sortBuckets(items, buckets);
}

// ── strategy (3): directory subdivision ────────────────────────────────────────────

/**
 * Partition items by their next PATH SEGMENT under a shared prefix (design B1 source 3 — "where
 * a path prefix is available"). Items sharing a longest-common-prefix are split by the first
 * differing path segment, so files in the same subdirectory land together. Returns null when no
 * item has a path, when the split yields fewer than {@link SUBDIVISION_THRESHOLDS.minBuckets}
 * groups (every item in one directory — no structure), when it yields more than `maxFanout`
 * groups, or when degenerate.
 */
function tryDirectory(items: readonly SubdivisionItem[], maxFanout: number): number[][] | null {
  if (!items.some((it) => it.pathPrefix.length > 0)) return null;

  // Longest common path prefix (segment-wise) across all items WITH a path; pathless items are
  // bucketed together under a stable empty key so they never block the directory split.
  const withPath = items.filter((it) => it.pathPrefix.length > 0);
  const lcp = longestCommonSegmentPrefix(withPath.map((it) => it.pathPrefix));

  const bucketByKey = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const key = nextSegmentKey(items[i].pathPrefix, lcp);
    let bucket = bucketByKey.get(key);
    if (bucket === undefined) bucketByKey.set(key, (bucket = []));
    bucket.push(i);
  }
  const buckets = [...bucketByKey.values()];
  if (buckets.length < SUBDIVISION_THRESHOLDS.minBuckets) return null;
  if (buckets.length > maxFanout) return null;
  if (!balanceOk(items, buckets)) return null;
  return sortBuckets(items, buckets);
}

/** Split a "/"-delimited path into non-empty segments. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** The longest path prefix (in whole segments) common to every path. "" when none share a root. */
function longestCommonSegmentPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let common = segments(paths[0]);
  for (let p = 1; p < paths.length && common.length > 0; p++) {
    const segs = segments(paths[p]);
    let k = 0;
    while (k < common.length && k < segs.length && common[k] === segs[k]) k++;
    common = common.slice(0, k);
  }
  return common.join("/");
}

/**
 * The bucketing key for `path` under the common prefix `lcp`: the first path segment BELOW the
 * common prefix (so siblings in the same subdirectory share a key). A path equal to the prefix
 * (a file directly in the common dir) keys to "." so it groups with its peers; a pathless item
 * keys to "" (its own stable bucket).
 */
function nextSegmentKey(path: string, lcp: string): string {
  if (path.length === 0) return "";
  const pathSegs = segments(path);
  const lcpSegs = segments(lcp);
  if (pathSegs.length <= lcpSegs.length) return ".";
  return pathSegs[lcpSegs.length];
}

// ── strategy (4): deterministic balanced chunks (always available) ─────────────────

/**
 * Partition `count` item indices into contiguous chunks of at most `maxFanout` (design B1
 * source 4). Canonical order is preserved (the items are already in canonical order), so the
 * chunks are deterministic and stable. ALWAYS valid — this is the fallback that guarantees the
 * fan-out invariant when every smarter strategy is rejected or skipped.
 */
export function balancedChunks(count: number, maxFanout: number): number[][] {
  const buckets: number[][] = [];
  for (let i = 0; i < count; i += maxFanout) {
    const chunk: number[] = [];
    for (let j = i; j < Math.min(i + maxFanout, count); j++) chunk.push(j);
    buckets.push(chunk);
  }
  return buckets;
}

// ── validation + determinism helpers ───────────────────────────────────────────────

/**
 * BALANCE check (impl note c — REJECT "one huge + several tiny"). A partition is balanced unless
 * a single bucket dominates: it holds more than {@link SUBDIVISION_THRESHOLDS.maxDominantWeightFraction}
 * of the total LEAF WEIGHT while ≥1 other bucket exists. Weight (not item count) is used so a
 * community that swallowed almost every node into one giant community — the canonical degeneracy —
 * is rejected even if it nominally produced many buckets.
 */
function balanceOk(items: readonly SubdivisionItem[], buckets: readonly number[][]): boolean {
  if (buckets.length < 2) return true; // a single bucket can't be "dominant vs the rest"
  let total = 0;
  for (const it of items) total += Math.max(1, it.leafWeight);
  if (total === 0) return true;
  let maxBucketWeight = 0;
  for (const bucket of buckets) {
    let w = 0;
    for (const idx of bucket) w += Math.max(1, items[idx].leafWeight);
    if (w > maxBucketWeight) maxBucketWeight = w;
  }
  return maxBucketWeight <= total * SUBDIVISION_THRESHOLDS.maxDominantWeightFraction;
}

/**
 * Sort buckets (and items within each) deterministically by ascending member rep id, so the
 * partition is independent of Map iteration order. Within a bucket, indices are sorted by their
 * item's repId; buckets are then sorted by their first member's repId.
 */
function sortBuckets(items: readonly SubdivisionItem[], buckets: number[][]): number[][] {
  for (const bucket of buckets) bucket.sort((x, y) => items[x].repId - items[y].repId);
  buckets.sort((p, q) => items[p[0]].repId - items[q[0]].repId);
  return buckets;
}
