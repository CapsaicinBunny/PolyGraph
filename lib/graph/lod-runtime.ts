// LOD runtime — committed-cut generations + bounded offscreen eviction (spec → "State
// machine + committed generations" + Appendix A §K, §J state machine).
//
// Camera motion updates a PENDING cut; after debounce/hysteresis a MATERIALLY-different
// cut (a changed CutSignature — §K: node selection AND edge/label degradation stage AND
// filters) is COMMITTED, incrementing `generation`. ONLY a committed generation triggers
// the expensive downstream work (scene rebuild / edge aggregation / local-layout load /
// renderer payload) — pending churn on a volatile pan must be cheap.
//
// The auto-open eviction LRU uses a pre-allocated INTRUSIVE doubly-linked list (not array
// shift() / not churning Sets), so evicting offscreen refinements over budget never
// triggers a GC pause on a fast pan. Reps are integers, so the list nodes are the rep ids
// themselves — prev/next/inList are parallel typed arrays indexed by rep id (O(1) touch /
// remove / evict, zero allocation after construction).
//
// Pure data structure + controller; no React, no GPU.

import type { CutSignature, LodCut } from "./lod-cut-solver";
import { cutSignaturesEqual } from "./lod-cut-solver";

/**
 * The camera's only owned state (spec "committed generations"): the pending cut it is
 * building, the committed cut the renderer/scene consume, the committed generation, and
 * the committed cut's signature (for the material-change test).
 */
export interface LodRuntimeState {
  pendingCut: LodCut;
  committedCut: LodCut;
  generation: number;
  pendingSignature: CutSignature;
  committedSignature: CutSignature;
}

/** Create the runtime with an initial cut as both pending and committed (generation 0). */
export function createLodRuntime(initial: LodCut, signature: CutSignature): LodRuntimeState {
  return {
    pendingCut: initial,
    committedCut: initial,
    generation: 0,
    pendingSignature: signature,
    committedSignature: signature,
  };
}

/**
 * Stage a new pending cut + its signature (camera motion / a fresh solve). Cheap — it
 * does NOT commit, does NOT bump the generation, and triggers no downstream rebuild.
 */
export function setPending(state: LodRuntimeState, cut: LodCut, signature: CutSignature): void {
  state.pendingCut = cut;
  state.pendingSignature = signature;
}

/**
 * Commit the pending cut IFF it is materially different from the committed one (§K). On a
 * material change: swap committed←pending, bump `generation`, and return true (the caller
 * then rebuilds the scene / re-aggregates edges / re-renders). On an immaterial change
 * (identical signature): leave everything untouched and return false. This is the ONE gate
 * that decides whether a generation fires.
 */
export function commitIfMaterial(state: LodRuntimeState): boolean {
  if (cutSignaturesEqual(state.pendingSignature, state.committedSignature)) return false;
  state.committedCut = state.pendingCut;
  state.committedSignature = state.pendingSignature;
  state.generation += 1;
  return true;
}

// ── Intrusive doubly-linked-list LRU ─────────────────────────────────────────

/**
 * A fixed-capacity LRU over integer keys (rep ids), backed by a pre-allocated intrusive
 * doubly-linked list. `touch` marks a key most-recently-used; `evictOldest` removes the
 * least-recently-used. When an optional soft `capacity` is set, `touch` auto-evicts the
 * oldest once the size would exceed it, returning the auto-evicted key (or -1).
 *
 * No array `shift()`, no Set churn: prev/next/inList are typed arrays indexed by key, so
 * every op is O(1) with zero allocation after construction — the spec's "no GC pause on
 * volatile pans" requirement. `keySpace` is the exclusive upper bound on keys (e.g. the
 * rep count); keys must be in [0, keySpace).
 */
export class IntrusiveLru {
  private readonly prev: Int32Array;
  private readonly next: Int32Array;
  private readonly inList: Uint8Array;
  /** Oldest (LRU) end; -1 when empty. */
  private head = -1;
  /** Newest (MRU) end; -1 when empty. */
  private tail = -1;
  private count = 0;
  private readonly capacity: number;

  constructor(keySpace: number, capacity = Infinity) {
    this.prev = new Int32Array(keySpace).fill(-1);
    this.next = new Int32Array(keySpace).fill(-1);
    this.inList = new Uint8Array(keySpace);
    this.capacity = capacity;
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.count;
  }

  /** Whether a key is currently in the list. */
  has(key: number): boolean {
    return this.inList[key] === 1;
  }

  /**
   * Mark `key` most-recently-used (insert if absent, else move to the MRU tail). Returns
   * an auto-evicted key when the insert pushes the size over `capacity`, else -1. The
   * auto-eviction happens BEFORE the insert when already at capacity, so the just-touched
   * key always survives.
   */
  touch(key: number): number {
    let evicted = -1;
    if (this.inList[key] === 1) {
      this.unlink(key);
    } else if (this.count >= this.capacity) {
      // At capacity and inserting a new key → evict the oldest to make room.
      evicted = this.evictOldest();
    }
    this.linkAtTail(key);
    return evicted;
  }

  /** Remove + return the least-recently-used key, or -1 when empty. */
  evictOldest(): number {
    if (this.head === -1) return -1;
    const oldest = this.head;
    this.unlink(oldest);
    return oldest;
  }

  /** Remove a specific key if present (no-op when absent). */
  remove(key: number): void {
    if (this.inList[key] === 1) this.unlink(key);
  }

  /** Append `key` at the MRU (tail) end. Assumes `key` is not currently linked. */
  private linkAtTail(key: number): void {
    this.prev[key] = this.tail;
    this.next[key] = -1;
    if (this.tail === -1) this.head = key;
    else this.next[this.tail] = key;
    this.tail = key;
    this.inList[key] = 1;
    this.count += 1;
  }

  /** Splice `key` out of the list. Assumes `key` is currently linked. */
  private unlink(key: number): void {
    const p = this.prev[key];
    const n = this.next[key];
    if (p === -1) this.head = n;
    else this.next[p] = n;
    if (n === -1) this.tail = p;
    else this.prev[n] = p;
    this.prev[key] = -1;
    this.next[key] = -1;
    this.inList[key] = 0;
    this.count -= 1;
  }
}
