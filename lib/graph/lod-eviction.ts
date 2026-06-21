// Bounded offscreen-auto-open eviction + in-place runtime-cut roll (spec → "State machine
// + committed generations": "auto open & offscreen → eviction-eligible … over budget →
// evict lowest-priority eligible reps (LRU)"; Appendix A §J). Phase C1c review bug (b).
//
// This wires up the two C1b structures that had no production caller: IntrusiveLru and
// advanceRuntimeCut. The controller persists ACROSS recuts (the canvas holds it on a ref):
//
//  - It tracks which group proxies are currently auto-OPENED. On-screen opens are kept
//    fresh (moved to MRU each frame); offscreen opens AGE (never refreshed while offscreen)
//    so they are the first to go. When the tracked set exceeds the offscreen-open BUDGET,
//    the oldest tracked reps are evicted — the caller force-closes them, so a long
//    exploration of many regions can't grow auto-opens without bound. The cumulative count
//    drives the overlay's `evictions` stat (which was always 0).
//
//  - It owns a single RuntimeLodCut and rolls it forward IN PLACE (advanceRuntimeCut) when
//    the rep count is unchanged — bumping the epoch, reusing the backing Uint32Array — so a
//    volatile pan allocates no fresh array per frame. A changed rep count (the grouping
//    changed) allocates a fresh runtime cut.
//
// Pure controller (no React, no GPU); the canvas owns the instance and the re-solve.

import { IntrusiveLru } from "./lod-runtime";
import {
  advanceRuntimeCut,
  type LodCut,
  makeRuntimeCut,
  type RuntimeLodCut,
} from "./lod-cut-solver";

/** The outcome of recording one frame's open set: which reps to evict + the count. */
export interface EvictionOutcome {
  /** Group reps the caller should force-closed this frame (LRU over-budget victims). */
  evicted: Set<number>;
  /** How many were evicted this frame (== evicted.size; convenient for the overlay). */
  count: number;
}

/**
 * The persistent eviction + runtime-cut controller. One instance lives on the canvas ref
 * across recuts; `recordOpen` bounds the auto-opens and `advanceCut` rolls the runtime cut.
 */
export interface EvictionController {
  /**
   * Record the currently-OPEN auto group reps for this frame and return the over-budget
   * evictions. `isOnScreen(rep)` distinguishes on-screen opens (kept fresh) from offscreen
   * ones (aged, evicted first). Reps that were open last frame but are absent now are
   * dropped from tracking (a closed group no longer counts toward the budget).
   */
  recordOpen(
    openGroupReps: Iterable<number>,
    isOnScreen: (rep: number) => boolean,
  ): EvictionOutcome;
  /**
   * Roll the runtime cut forward. When `repCount` matches the live runtime cut's size, the
   * existing one is advanced IN PLACE (epoch bump, same backing array — no allocation);
   * otherwise a fresh runtime cut is built (the grouping/rep count changed).
   */
  advanceCut(cut: LodCut, repCount: number): RuntimeLodCut;
  /** The group reps currently retained as auto-open (the deadband set carried forward). */
  retained(): number[];
  /** The rep-id key space this controller was sized for (the hierarchy's rep count). */
  readonly keySpace: number;
  /** Number of group reps currently tracked as auto-open. */
  readonly trackedSize: number;
  /** Cumulative evictions since construction (the overlay's running `evictions` stat). */
  readonly totalEvictions: number;
  /** Forget all tracking + the runtime cut (e.g. on a grouping-mode switch). */
  reset(): void;
}

/**
 * Build an eviction controller. `keySpace` is the exclusive upper bound on rep ids the LRU
 * must hold (the rep count); `offscreenOpenBudget` is the maximum number of auto-opened
 * group proxies retained before the oldest are evicted.
 */
export function makeEvictionController(
  keySpace: number,
  offscreenOpenBudget: number,
): EvictionController {
  // The LRU tracks auto-open group reps by recency. Capacity is Infinity here — we evict
  // EXPLICITLY down to the budget after refreshing on-screen opens, so the victim is always
  // the genuinely-oldest tracked rep (deterministic), not whatever an insert happened to
  // push over an internal cap mid-pass.
  let lru = new IntrusiveLru(Math.max(1, keySpace));
  // The set of reps currently tracked as open (mirrors the LRU membership; lets us diff
  // against the new frame's open set to drop reps that closed).
  let tracked = new Set<number>();
  let totalEvictions = 0;
  let runtimeCut: RuntimeLodCut | null = null;

  return {
    recordOpen(openGroupReps, isOnScreen) {
      const open = new Set<number>(openGroupReps);

      // 1. Drop reps that were tracked but are no longer open (the group closed).
      for (const rep of [...tracked]) {
        if (!open.has(rep)) {
          lru.remove(rep);
          tracked.delete(rep);
        }
      }

      // 2. Refresh on-screen opens to MRU; insert offscreen opens once (then let them age).
      //    Process on-screen first so a freshly-touched on-screen rep is always newer than
      //    an already-tracked offscreen rep; insert newly-seen offscreen reps last so they
      //    start at MRU (a just-opened offscreen region isn't evicted before older ones).
      const openList = [...open];
      for (const rep of openList) {
        if (isOnScreen(rep)) {
          lru.touch(rep); // insert or refresh to MRU
          tracked.add(rep);
        }
      }
      for (const rep of openList) {
        if (!isOnScreen(rep) && !tracked.has(rep)) {
          lru.touch(rep); // first sighting → insert at MRU
          tracked.add(rep);
        }
      }

      // 3. Evict down to the budget — the oldest tracked reps (offscreen ones age to the
      //    head, on-screen ones were just refreshed to the tail).
      const evicted = new Set<number>();
      while (lru.size > offscreenOpenBudget) {
        const victim = lru.evictOldest();
        if (victim === -1) break;
        tracked.delete(victim);
        evicted.add(victim);
      }
      totalEvictions += evicted.size;
      return { evicted, count: evicted.size };
    },

    advanceCut(cut, repCount) {
      if (runtimeCut && runtimeCut.selectedEpoch.length === repCount) {
        return advanceRuntimeCut(runtimeCut, cut); // in-place roll (no allocation)
      }
      runtimeCut = makeRuntimeCut(cut, repCount); // fresh (first call or rep count changed)
      return runtimeCut;
    },

    retained() {
      return [...tracked];
    },
    keySpace,
    get trackedSize() {
      return tracked.size;
    },
    get totalEvictions() {
      return totalEvictions;
    },
    reset() {
      lru = new IntrusiveLru(Math.max(1, keySpace));
      tracked = new Set();
      runtimeCut = null;
    },
  };
}
