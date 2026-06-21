// Async cut/layout readiness — the SINGLE atomic readiness policy (design B3 + impl note
// (d)). Phase P3 ("async-readiness").
//
// A committed solve produces a PENDING target cut (a valid antichain — see lod-runtime.ts /
// lod-cut-solver.ts). Turning that pending cut into a rendered scene is NOT instantaneous: a
// proxy that OPENS (a refinement) needs a LOCAL LAYOUT for its newly-revealed children, and
// that layout may not be cached. Rev 3 pins exactly one policy for the gap between "pending
// target" and "committed scene":
//
//   1. The solver produces a PENDING target cut (not yet committed).            [caller]
//   2. CACHED local layouts for affected subtrees resolve IMMEDIATELY.          [here]
//   3. MISSING local layouts run ASYNC (worker), tagged with the target gen.    [here → caller]
//   4. The CURRENT committed cut stays visible meanwhile — no blank/partial.    [here: no commit]
//   5. When ALL data for ONE subtree transition is ready it commits ATOMICALLY. [here]
//   6. STALE generations are discarded — a result whose gen ≠ live target drops. [here]
//
// Impl note (d) SPLITS coarsening from refinement so a zoom-out / eviction never waits on a
// worker it does not need:
//
//   - COARSENING (a proxy that FOLDED — `diff.coarsened`) commits IMMEDIATELY after proxy +
//     edge materialization (no async layout: folding reveals no new children).
//   - A refinement with a cache HIT commits IMMEDIATELY.
//   - A refinement with a cache MISS RETAINS the existing proxy until the local layout returns.
//   - A MIXED connected batch waits until ALL its required refinements are ready (impl note
//     (b)'s connected-batch rule still governs which subtrees commit together).
//
// This module is the ORCHESTRATION ONLY: it decides what commits now, what must run async, what
// is stale, and which obsolete in-flight requests to cancel. It runs NO layout algorithm, reads
// no engine name, and does no scene mutation itself — the caller drives the actual fold (via the
// IncrementalSceneSession) and the worker. Pure + deterministic; no React, no GPU.
//
// WIRING (P3): this wires the previously-unwired single-readiness design into the rep-cut path.
// The local-layout cache (local-layout.ts) gets the LRU/memory cap the spec's P3 demands
// ("cache memory limit / LRU, cancellation of obsolete requests, generation tokens in worker
// responses") — local-layout.ts itself is a bare Map; this layer bounds it.

import type { CachedLocalLayout } from "./local-layout";
import type { CutDiff } from "./proxy-materialize";
import type { RepresentationHierarchy } from "./representation";

/**
 * The cache key a refinement's local layout lives under. In the live path this is the
 * `(groupBoxKey, ProxyCacheKey)` pair the LocalLayoutCache uses; here it is opaque — the
 * readiness layer only needs equality + a probe ("is it cached?"), never the layout's content.
 * A string is the canonical serialized form (serializeProxyCacheKey + box key); see local-layout.ts.
 */
export type LayoutCacheKey = string;

/**
 * A bounded local-layout cache (the spec's P3 "cache memory limit / LRU"). Wraps an
 * insertion-ordered Map with an LRU eviction by ENTRY COUNT and an optional BYTE cap (a coarse
 * sum of each layout's estimated footprint). On `set`, the least-recently-used entries are
 * evicted until BOTH caps hold; `get` promotes a hit to most-recently-used. Distinct from
 * local-layout.ts's bare `makeLocalLayoutCache` (which has NO cap — it would leak unbounded
 * across exploration); this is the production cache the readiness orchestrator owns.
 *
 * Keyed by an opaque {@link LayoutCacheKey} string so it is independent of the ProxyCacheKey
 * shape; the caller serializes its `(boxKey, ProxyCacheKey)` into that string.
 */
export class BoundedLayoutCache {
  // JS Map preserves insertion order → iterating keys yields LRU-first once we re-insert on hit.
  private readonly map = new Map<LayoutCacheKey, CachedLocalLayout>();
  private bytes = 0;
  private readonly byteOf = new Map<LayoutCacheKey, number>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = 512, maxBytes = 64 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /** Current entry count. */
  get size(): number {
    return this.map.size;
  }

  /** Current estimated byte footprint. */
  get byteSize(): number {
    return this.bytes;
  }

  /** Whether a layout is cached for `key` (a probe — does NOT promote LRU). */
  has(key: LayoutCacheKey): boolean {
    return this.map.has(key);
  }

  /** The cached layout for `key`, promoting it to most-recently-used; undefined on a miss. */
  get(key: LayoutCacheKey): CachedLocalLayout | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Promote: delete + re-insert so it moves to the most-recent (last) position.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Store a layout, then evict LRU entries until both the entry and byte caps hold. */
  set(key: LayoutCacheKey, layout: CachedLocalLayout): void {
    if (this.map.has(key)) {
      this.bytes -= this.byteOf.get(key) ?? 0;
      this.map.delete(key);
    }
    const b = estimateLayoutBytes(layout);
    this.map.set(key, layout);
    this.byteOf.set(key, b);
    this.bytes += b;
    this.evictToCaps();
  }

  /** Drop a specific entry (no-op when absent). */
  delete(key: LayoutCacheKey): void {
    if (!this.map.has(key)) return;
    this.bytes -= this.byteOf.get(key) ?? 0;
    this.byteOf.delete(key);
    this.map.delete(key);
  }

  /** Drop everything (e.g. on a material relayout). */
  clear(): void {
    this.map.clear();
    this.byteOf.clear();
    this.bytes = 0;
  }

  // Evict the least-recently-used (front of the Map iteration order) until both caps hold.
  // The just-`set` entry is at the BACK, so it is never the eviction victim — a fresh insert
  // larger than the cap alone stays (the cache never drops what it was just asked to hold).
  private evictToCaps(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as LayoutCacheKey | undefined;
      if (oldest === undefined) break;
      if (this.map.size === 1) break; // never evict the sole (just-set) entry
      this.bytes -= this.byteOf.get(oldest) ?? 0;
      this.byteOf.delete(oldest);
      this.map.delete(oldest);
    }
  }
}

/**
 * A coarse byte estimate for one cached local layout (positions + nested cluster boxes). Used
 * only for the cache's BYTE cap — it need not be exact, only monotone in real footprint. ~40B
 * per positioned node, ~64B per cluster box; a floor of 64B so an empty layout still costs.
 */
export function estimateLayoutBytes(layout: CachedLocalLayout): number {
  return 64 + layout.positions.size * 40 + layout.clusters.length * 64;
}

/**
 * The disposition of ONE changed-subtree root in a pending transition (design B3 + (d)). A root
 * is either:
 *   - "coarsen"      — folded (in `diff.coarsened`): commits immediately, no async layout.
 *   - "refine-hit"   — opened (in `diff.refined`) AND its local layout is cached: immediate.
 *   - "refine-miss"  — opened AND its local layout is NOT cached: the existing proxy is RETAINED
 *                      and an async layout request is issued (generation-tagged).
 */
export type RootDisposition = "coarsen" | "refine-hit" | "refine-miss";

/** Per-root classification of a pending transition. */
export interface RootReadiness {
  /** The changed-subtree root rep. */
  root: number;
  disposition: RootDisposition;
  /** The cache key the root's local layout lives under (only meaningful for the refine cases). */
  cacheKey: LayoutCacheKey;
}

/**
 * Classify every changed-subtree root of a {@link CutDiff} into its {@link RootDisposition}
 * (design B3 + impl note (d)). `cacheKeyOf` maps a refined (opening) root rep to the cache key
 * its local layout would live under; `cache.has(key)` is the HIT/MISS probe. Coarsened roots
 * (folds) need no layout, so they are always immediate ("coarsen").
 *
 * The diff's `refined` are reps selected BEFORE but not after (a proxy that OPENED — its subtree
 * expands and needs a layout); `coarsened` are reps newly selected (a proxy that FOLDED). This is
 * the proxy-materialize.ts vocabulary; see {@link CutDiff}.
 *
 * Returns the classification in deterministic order (coarsened roots first, then refined roots,
 * each ascending) so the readiness decision is a pure function of the diff + cache state.
 */
export function classifyTransition(
  diff: CutDiff,
  cache: BoundedLayoutCache,
  cacheKeyOf: (root: number) => LayoutCacheKey,
): RootReadiness[] {
  const out: RootReadiness[] = [];
  const coarsened = Array.from(diff.coarsened).sort((a, b) => a - b);
  const refined = Array.from(diff.refined).sort((a, b) => a - b);
  for (const root of coarsened) {
    out.push({ root, disposition: "coarsen", cacheKey: cacheKeyOf(root) });
  }
  for (const root of refined) {
    const cacheKey = cacheKeyOf(root);
    out.push({
      root,
      disposition: cache.has(cacheKey) ? "refine-hit" : "refine-miss",
      cacheKey,
    });
  }
  return out;
}

/**
 * The split of a pending transition into what can commit NOW versus what must wait on an async
 * layout (design B3 rules 2–5 + impl note (d)). `immediateRoots` = every coarsen + every
 * refine-HIT root: their data is ready, so the caller folds them into the scene atomically right
 * now (the prior committed cut stays visible for everything else — rule 4). `pendingRoots` =
 * every refine-MISS root: the caller RETAINS the existing proxy and issues an async layout
 * request for each, tagged with `targetGeneration`. `requests` carries those misses so the caller
 * can dispatch them (and the readiness controller can track them for staleness + cancellation).
 */
export interface TransitionPlan {
  targetGeneration: number;
  immediateRoots: number[];
  pendingRoots: number[];
  requests: LayoutRequest[];
}

/** An async local-layout request for a refine-MISS root (generation-tagged — B3 rule 3). */
export interface LayoutRequest {
  root: number;
  cacheKey: LayoutCacheKey;
  targetGeneration: number;
}

/**
 * Plan a pending transition: classify each changed root, then partition into the immediate set
 * (coarsen ∪ refine-hit) and the pending set (refine-miss), emitting an async {@link LayoutRequest}
 * per miss. Pure — it mutates nothing (not even the cache). The caller commits `immediateRoots`
 * atomically, retains proxies for `pendingRoots`, and dispatches `requests` to the worker.
 */
export function planTransition(
  diff: CutDiff,
  cache: BoundedLayoutCache,
  cacheKeyOf: (root: number) => LayoutCacheKey,
  targetGeneration: number,
): TransitionPlan {
  const classified = classifyTransition(diff, cache, cacheKeyOf);
  const immediateRoots: number[] = [];
  const pendingRoots: number[] = [];
  const requests: LayoutRequest[] = [];
  for (const c of classified) {
    if (c.disposition === "refine-miss") {
      pendingRoots.push(c.root);
      requests.push({ root: c.root, cacheKey: c.cacheKey, targetGeneration });
    } else {
      immediateRoots.push(c.root);
    }
  }
  return { targetGeneration, immediateRoots, pendingRoots, requests };
}

/**
 * The verdict on an async layout result that just arrived (design B3 rule 6). A result is
 * accepted ONLY when its generation matches the live target AND the request is still tracked
 * (not cancelled). Otherwise it is dropped as STALE — the cut moved on while the worker ran, so
 * committing the result would render an antichain that is no longer the target.
 */
export type ResultVerdict = "accept" | "stale-generation" | "cancelled";

/**
 * Tracks in-flight async layout requests so a returning result can be judged ready (accept),
 * STALE (its generation was superseded), or CANCELLED (the request was withdrawn because a newer
 * target obsoleted it). This is the controller half of B3 rules 3/6 + the P3 "cancellation of
 * obsolete requests" requirement.
 *
 * The live generation only ever advances (each committed solve bumps it — see lod-runtime.ts).
 * `beginGeneration(g)` sets the live target and CANCELS every still-pending request from an older
 * generation (they can no longer be accepted, so there is no point letting the worker's result
 * land). `track`/`resolve` book-keep one request's lifecycle.
 */
export class ReadinessController {
  /** The live target generation — only results tagged with this can be accepted. */
  private liveGeneration = 0;
  // root → the generation of the in-flight request for that root. A root has at most one
  // outstanding request; a newer request for the same root supersedes the older's tracking.
  private readonly inFlight = new Map<number, number>();
  // Generations explicitly cancelled (so a late result is judged "cancelled", not "stale").
  private readonly cancelledRoots = new Set<number>();

  /** The current live target generation. */
  get generation(): number {
    return this.liveGeneration;
  }

  /** Number of currently in-flight (tracked, not-yet-resolved) requests. */
  get pendingCount(): number {
    return this.inFlight.size;
  }

  /**
   * Advance the live target to generation `g` and CANCEL every in-flight request whose generation
   * is older than `g` (an obsolete request — its result, if it ever lands, will be judged
   * "cancelled"). Returns the roots whose requests were cancelled, so the caller can abort the
   * corresponding worker jobs. `g` must be ≥ the current generation (generations are monotonic).
   */
  beginGeneration(g: number): number[] {
    if (g < this.liveGeneration) return [];
    this.liveGeneration = g;
    const cancelled: number[] = [];
    for (const [root, gen] of this.inFlight) {
      if (gen < g) {
        cancelled.push(root);
        this.cancelledRoots.add(root);
      }
    }
    for (const root of cancelled) this.inFlight.delete(root);
    cancelled.sort((a, b) => a - b);
    return cancelled;
  }

  /** Record that an async request for `root` at generation `g` is now in flight. */
  track(root: number, g: number): void {
    this.inFlight.set(root, g);
    this.cancelledRoots.delete(root); // a fresh request un-cancels the root
  }

  /**
   * Judge an arrived result for `root` tagged with generation `g`:
   *   - "cancelled"         — the request was cancelled (a newer target obsoleted it).
   *   - "stale-generation"  — `g` ≠ the live target generation (the cut moved on).
   *   - "accept"            — `g` is live AND the request is still tracked → commit it.
   * Accepting (or finding it stale while still tracked) clears the in-flight entry. A cancelled
   * result leaves no tracking to clear (beginGeneration already removed it).
   */
  resolve(root: number, g: number): ResultVerdict {
    if (this.cancelledRoots.has(root) && !this.inFlight.has(root)) {
      this.cancelledRoots.delete(root);
      return "cancelled";
    }
    const tracked = this.inFlight.get(root);
    if (g !== this.liveGeneration) {
      // Superseded by a newer generation. Drop the tracking (a stale result never commits) so a
      // re-request for this root at the live generation can be tracked cleanly.
      if (tracked === g) this.inFlight.delete(root);
      return "stale-generation";
    }
    // Live generation. Accept only when this is the request we tracked for it.
    if (tracked === undefined) return "stale-generation";
    this.inFlight.delete(root);
    return "accept";
  }

  /** Forget all tracking (e.g. on a material relayout / mode switch). */
  reset(): void {
    this.inFlight.clear();
    this.cancelledRoots.clear();
  }
}

// Re-export the hierarchy type so the canvas can type the cacheKeyOf closure against it without
// a second import line (the closure needs the hierarchy to map a root rep → its box key).
export type { RepresentationHierarchy };
