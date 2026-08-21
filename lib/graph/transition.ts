// Transition batches — the connected-transition commit policy (design B3 + impl note (b) +
// Gap 9 CutDiff). Phase P3.
//
// A committed recut may open AND close several proxies at once (the CutDiff's `refined` ∪
// `coarsened` changed-subtree roots). The single-atomic-per-subtree commit policy (B3) says
// each independent subtree transition commits atomically, so the rendered scene is a sequence
// of always-valid antichains. But impl note (b) refines that unit: two changed subtrees may
// have EDGES BETWEEN them, and committing one before the other changes the quotient graph the
// edge costs were computed against. So:
//
//   - Changed subtrees with NO boundary relationship commit INDEPENDENTLY (one batch each).
//   - Subtrees connected by AFFECTED quotient edges commit as ONE batch (the atomic unit is
//     the connected component over the changed-root boundary graph, not an isolated subtree).
//   - EVERY batch revalidates the HARD budgets immediately before commit.
//   - A REJECTED batch (would breach a hard ceiling) leaves BOTH the scene and the committed
//     cut UNCHANGED — it is a pure no-op, and the other (accepted) batches still commit.
//
// This module is the orchestration: it groups the diff into batches, revalidates each against
// the live committed cut, and drives the IncrementalMaterializer to apply accepted batches one
// at a time. It runs no layout ALGORITHM and reads no engine name. Pure; deterministic.
//
// WIRING (P3): this wires the previously-unwired CutDiff/TransitionBatch design into the scene
// path. The committed cut is advanced INCREMENTALLY by accepted batches (a rejected batch is
// skipped), so a forced open that would explode the visible edge count past `hardEdges` is
// dropped while its independent neighbours still refine.

import type { LodBudget, LodCut } from "./lod-cut-solver";
import type { RepresentationEdgeIndex } from "./representation-edge-index";
import type { RepresentationColumns, RepresentationHierarchy } from "./representation";
import { representationBoundsOf } from "./representation-bounds";
import { type OverflowResolution, resolveOverflow } from "./overflow-ladder";
import {
  type CutDiff,
  diffCuts,
  type IncrementalMaterializer,
  type MaterializeCounter,
} from "./proxy-materialize";
import type { GraphModel } from "./types";

/**
 * Re-export the {@link CutDiff} computation (design Gap 9). The diff is the input to batch
 * grouping: its `refined ∪ coarsened` changed-subtree roots are partitioned into
 * {@link TransitionBatch}es. `computeCutDiff` is an alias for {@link diffCuts} so the P3
 * transition API reads in the spec's vocabulary ("Compute CutDiff") without a second impl.
 */
export const computeCutDiff = diffCuts;
export type { CutDiff };

/**
 * One atomically-committed transition (design impl note (b)). `roots` are the changed-subtree
 * roots (from the {@link CutDiff}, `refined ∪ coarsened`) that commit TOGETHER — either a
 * single isolated subtree (no boundary relationship) or a connected component of subtrees
 * joined by affected quotient edges. `targetGeneration` tags the batch with the cut generation
 * it belongs to, so a layout/commit result whose generation ≠ the live target is discarded
 * (B3 rule 6 — stale generations dropped). A batch is the UNIT of atomic commit and of hard-
 * budget revalidation: it commits whole or not at all.
 */
export interface TransitionBatch {
  roots: Uint32Array;
  targetGeneration: number;
}

/**
 * Group the changed-subtree roots of a {@link CutDiff} into {@link TransitionBatch}es (design
 * impl note (b)). Two changed roots land in the SAME batch iff some affected quotient edge
 * crosses between their subtrees — i.e. an indexed (post-filter) edge has one endpoint under
 * one changed root and the other endpoint under a DISTINCT changed root. Roots with no such
 * relationship are each their own batch (they commit independently). The grouping is a
 * connected-components partition over the "changed-root boundary graph".
 *
 * Determinism: batches are returned sorted by their smallest root, and each batch's `roots`
 * are ascending — so the batch sequence is a pure function of the diff + hierarchy + index,
 * never of Set iteration order. O(changedRoots + indexedEdges incident to the changed region).
 *
 * Without an `edgeIndex` (no post-filter edges supplied) there are no quotient edges to relate
 * subtrees, so every changed root is its own batch (the conservative independent-commit path).
 */
export function groupTransitionBatches(
  diff: CutDiff,
  hierarchy: RepresentationHierarchy,
  edgeIndex: RepresentationEdgeIndex | undefined,
  targetGeneration: number,
): TransitionBatch[] {
  const cols = hierarchy.columns;
  // The changed reps = refined ∪ coarsened (de-duplicated). But a refine/coarsen of one proxy
  // shows up in the diff as the proxy rep on one side AND its descendant reps on the other (a
  // refine: `refined={proxy}`, `coarsened={its children/leaves}`; a coarsen is the transpose).
  // The changed SUBTREE ROOT is the proxy — its descendants are WITHIN its subtree, not
  // independent roots. So reduce the changed set to its MAXIMAL elements: keep only reps with no
  // changed ANCESTOR. Each maximal rep is one changed subtree root (impl note (b)'s commit unit).
  const changedSet = new Set<number>();
  for (let i = 0; i < diff.refined.length; i++) changedSet.add(diff.refined[i]);
  for (let i = 0; i < diff.coarsened.length; i++) changedSet.add(diff.coarsened[i]);
  const hasChangedAncestor = (rep: number): boolean => {
    let cur = cols.parentByRep[rep];
    let guard = cols.parentByRep.length + 1;
    while (cur >= 0 && guard-- > 0) {
      if (changedSet.has(cur)) return true;
      cur = cols.parentByRep[cur];
    }
    return false;
  };
  const changed: number[] = [];
  for (const r of changedSet) if (!hasChangedAncestor(r)) changed.push(r);
  changed.sort((a, b) => a - b);

  // Union-find over the changed roots (indexed by position in `changed`).
  const n = changed.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // path-halving
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra < rb ? ra : rb] = ra < rb ? rb : ra;
  };

  // Map a changed root → its index in `changed`. The boundary graph relates roots whose
  // subtrees an affected quotient edge crosses; we resolve each edge endpoint's CHANGED-ROOT
  // ancestor (the changed root whose subtree contains the endpoint's leaf), if any.
  const indexOfRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) indexOfRoot.set(changed[i], i);

  if (edgeIndex && n > 1) {
    // The changed-root ancestor of a leaf rep: walk up until a changed root is hit (or the
    // tree ends). Bounded by depth; the changed roots are disjoint subtrees, so at most one
    // matches. A leaf under no changed root returns -1 (it is in `unchanged` territory and
    // its edges relate no two changed batches).
    const changedRootOf = (leaf: number): number => {
      let cur = leaf;
      let guard = cols.parentByRep.length + 1;
      while (cur >= 0 && guard-- > 0) {
        const idx = indexOfRoot.get(cur);
        if (idx !== undefined) return idx;
        cur = cols.parentByRep[cur];
      }
      return -1;
    };
    // Only consider edges incident to the changed region: the edge index's incidence CSR is
    // keyed at the lowest-relevant-pair tier, so to be safe we scan the indexed edges' leaf
    // endpoints (bounded by the post-filter edge set, not the raw graph) and union any pair of
    // DISTINCT changed roots an edge crosses. This is the same leaf-walk `quotientEdgeCount`
    // uses, so it is correct for ANY cut depth (the pair-tier reps may be above the changed roots).
    const { edgeSrcLeaf, edgeDstLeaf } = edgeIndex;
    const m = edgeSrcLeaf.length;
    for (let e = 0; e < m; e++) {
      const ra = changedRootOf(edgeSrcLeaf[e]);
      if (ra === -1) continue;
      const rb = changedRootOf(edgeDstLeaf[e]);
      if (rb === -1 || ra === rb) continue;
      union(ra, rb);
    }
  }

  // Collect components → batches. Group changed roots by their union-find representative.
  const byComponent = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let list = byComponent.get(root);
    if (!list) byComponent.set(root, (list = []));
    list.push(changed[i]);
  }
  const batches: TransitionBatch[] = [];
  for (const list of byComponent.values()) {
    list.sort((a, b) => a - b);
    batches.push({ roots: Uint32Array.from(list), targetGeneration });
  }
  // Deterministic order: by each batch's smallest root.
  batches.sort((x, y) => x.roots[0] - y.roots[0]);
  return batches;
}

/** The selected ancestor-or-self of `rep` under `selected`, or -1 (the rep that represents it). */
function selectedRepOf(
  cols: RepresentationColumns,
  selected: ReadonlySet<number>,
  rep: number,
): number {
  let cur = rep;
  let guard = cols.parentByRep.length + 1;
  while (cur >= 0 && guard-- > 0) {
    if (selected.has(cur)) return cur;
    cur = cols.parentByRep[cur];
  }
  return -1;
}

/** The visible quotient-graph edge count of a selection (design B2) — the same metric the
 * solver charges to `edgeCost`. A quotient edge exists between two DISTINCT selected reps that
 * represent the two endpoints of some indexed edge. O(indexed edges · depth); 0 without an index. */
function quotientEdgeCount(
  cols: RepresentationColumns,
  edgeIndex: RepresentationEdgeIndex | undefined,
  selected: ReadonlySet<number>,
): number {
  if (!edgeIndex) return 0;
  const { edgeSrcLeaf, edgeDstLeaf } = edgeIndex;
  const m = edgeSrcLeaf.length;
  const seen = new Set<number>();
  let count = 0;
  for (let i = 0; i < m; i++) {
    const ra = selectedRepOf(cols, selected, edgeSrcLeaf[i]);
    const rb = selectedRepOf(cols, selected, edgeDstLeaf[i]);
    if (ra === -1 || rb === -1 || ra === rb) continue;
    const lo = ra < rb ? ra : rb;
    const hi = ra < rb ? rb : ra;
    const key = lo * 0x4000000 + hi;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

/** The cost dimensions a batch revalidation checks against the hard ceilings. */
interface BatchCost {
  cards: number;
  layout: number;
  edges: number;
  labels: number;
  gpu: number;
}

/** Sum the non-edge cost dims of a selection (cards = antichain width; layout = Σ nodeCost). */
function sumSelectionCost(cols: RepresentationColumns, selected: ReadonlySet<number>): BatchCost {
  let cards = 0;
  let layout = 0;
  let labels = 0;
  let gpu = 0;
  for (const r of selected) {
    cards += 1;
    layout += cols.nodeCost[r];
    labels += cols.labelCost[r];
    gpu += cols.gpuByteCost[r];
  }
  return { cards, layout, edges: 0, labels, gpu };
}

/**
 * Which hard ceiling (if any) a candidate selection breaches (design impl note (b) "every batch
 * revalidates hard budgets immediately before commit" + the finite budget model). Returns the
 * first breached dimension name, or null when the candidate is within ALL hard ceilings. The
 * edge dimension uses the cut-aware QUOTIENT count (B2), not an additive per-rep sum.
 */
export function hardBudgetBreach(
  cols: RepresentationColumns,
  edgeIndex: RepresentationEdgeIndex | undefined,
  selected: ReadonlySet<number>,
  budget: LodBudget,
): "cards" | "layout" | "edges" | "labels" | "gpu" | null {
  const cost = sumSelectionCost(cols, selected);
  if (cost.cards > budget.hardCards) return "cards";
  if (cost.layout > budget.hardLayoutCost) return "layout";
  const edges = quotientEdgeCount(cols, edgeIndex, selected);
  if (edges > budget.hardEdges) return "edges";
  if (cost.labels > budget.hardLabels) return "labels";
  if (cost.gpu > budget.maxGpuBytes) return "gpu";
  return null;
}

/**
 * Apply ONE batch's portion of the transition to a committed selection set (mutating it),
 * yielding the candidate selection AFTER that batch. For each batch root, the candidate replaces
 * EVERYTHING currently selected within the root's subtree `[entry, exit)` with the TARGET cut's
 * selected reps in that same subtree — which is exact for ANY tier depth (a multi-level refine
 * lands on the target's reps, not just the root's direct children) and handles open AND fold
 * uniformly (a fold's target reps in the range are just the root itself). The rest of the
 * selection (other batches' subtrees + every `unchanged` rep) is untouched, so a batch is a
 * LOCAL edit.
 *
 * Returns the set of reps the batch ADDED and REMOVED (for an exact rollback on rejection),
 * leaving the input `selected` mutated to the candidate. The caller reverts via {@link revertBatch}.
 */
function applyBatchToSelection(
  cols: RepresentationColumns,
  selected: Set<number>,
  batch: TransitionBatch,
  targetSelectionByRoot: ReadonlyMap<number, number[]>,
): { added: number[]; removed: number[] } {
  const added: number[] = [];
  const removed: number[] = [];
  for (let i = 0; i < batch.roots.length; i++) {
    const root = batch.roots[i];
    const entry = cols.entryByRep[root];
    const exit = cols.exitByRep[root];
    // Remove every currently-selected rep within this root's subtree.
    for (const r of [...selected]) {
      if (cols.entryByRep[r] >= entry && cols.exitByRep[r] <= exit) {
        selected.delete(r);
        removed.push(r);
      }
    }
    // Add the target cut's selected reps within this root's subtree.
    for (const r of targetSelectionByRoot.get(root) ?? []) {
      if (!selected.has(r)) {
        selected.add(r);
        added.push(r);
      }
    }
  }
  return { added, removed };
}

/** Undo {@link applyBatchToSelection} exactly (restore the pre-batch selection). */
function revertBatch(selected: Set<number>, added: number[], removed: number[]): void {
  for (const r of added) selected.delete(r);
  for (const r of removed) selected.add(r);
}

/** Default overflow-ladder tuning when the caller supplies none (mirrors the unit-test base). */
export const DEFAULT_OVERFLOW_TUNING = {
  /** How far past the box the compacted local layout may pan before grow is preferred. */
  maxPanRatio: 1.5,
  /** Sibling slack to borrow before growing the envelope (0 = none by default). */
  siblingSlackW: 0,
  siblingSlackH: 0,
} as const;

/**
 * Resolve the overflow of ONE refined subtree root against its tiered reservation (design P3
 * overflow + Appendix A §C). The root's refinement reveals its (bounded) children, which need
 * the next-tier reservation's extent; that extent is checked against the root's CURRENT box and
 * escalated through the SCOPED ladder — scale → clip-pan → borrow-slack → grow-envelope →
 * scoped-relayout — by {@link resolveOverflow}. The growth ceiling is the rep's
 * `growthEnvelope` (filled by {@link computeRepresentationBounds}), so envelope growth is CAPPED
 * by representation-bounds and the deepest escalation is a SCOPED subtree relayout. The result's
 * `global` field is ALWAYS false — a refinement never triggers a global relayout (the §C
 * invariant). A leaf / zero-box / unbounded rep resolves trivially at the scale rung.
 */
export function resolveBatchOverflow(
  cols: RepresentationColumns,
  rep: number,
  tuning: {
    maxPanRatio: number;
    siblingSlackW: number;
    siblingSlackH: number;
  } = DEFAULT_OVERFLOW_TUNING,
): OverflowResolution {
  const b = representationBoundsOf(cols, rep);
  // The refined contents need (at least) the NEXT-tier reservation's extent. That reservation is
  // already bounded by the direct-child count (never the full-leaf extent — the Space Paradox
  // fix), so it is the right "required" footprint to fit the children into the current box.
  const required = { x: b.current.x, y: b.current.y, w: b.nextReserved.w, h: b.nextReserved.h };
  return resolveOverflow({
    current: b.current,
    required,
    growthEnvelope: b.growthEnvelope,
    minScale: b.minScale > 0 ? b.minScale : 1,
    siblingSlackW: tuning.siblingSlackW,
    siblingSlackH: tuning.siblingSlackH,
    maxPanRatio: tuning.maxPanRatio,
  });
}

/** The outcome of committing a single {@link TransitionBatch}. */
export interface BatchCommitOutcome {
  batch: TransitionBatch;
  /** True iff the batch passed hard-budget revalidation and was applied to scene + cut. */
  committed: boolean;
  /** The hard ceiling that rejected the batch (null when committed). */
  rejectedBy: "cards" | "layout" | "edges" | "labels" | "gpu" | null;
  /**
   * The per-refined-root overflow resolutions for this batch (design P3 overflow). Every
   * resolution has `global === false` — a refined group escalates through the SCOPED ladder and
   * NEVER triggers a global relayout. A coarsen-only batch (no refined roots) has an empty array.
   */
  overflow: { root: number; resolution: OverflowResolution }[];
}

/** The result of committing a whole transition (one diff's worth of batches). */
export interface TransitionResult {
  /** The folded scene AFTER all accepted batches (the prior scene when none committed). */
  scene: GraphModel;
  /** The committed selection AFTER all accepted batches (a rejected batch left it unchanged). */
  committedSelection: Uint32Array;
  /** Per-batch outcome, in deterministic batch order. */
  outcomes: BatchCommitOutcome[];
  /** True iff at least one batch committed (the scene/cut changed). */
  anyCommitted: boolean;
  /**
   * True iff any COMMITTED refined root exhausted its growth envelope (the overflow ladder's
   * final `scoped-relayout` rung — design P3 overflow + global-relayout's `envelopeExhaustedNonce`).
   * This is the ONLY camera-adjacent signal that may later request a GLOBAL relayout: the caller
   * bumps {@link GlobalLayoutInputs.envelopeExhaustedNonce} on it. It is NOT a global relayout in
   * itself — the in-flight transition stays scoped (`resolution.global === false`); a global
   * relayout fires only on the NEXT solve through {@link globalRelayoutReason}.
   */
  envelopeExhausted: boolean;
}

/**
 * Commit a transition as a sequence of atomic {@link TransitionBatch}es (design B3 + impl note
 * (b)). Starting from the `committed` cut, each batch is:
 *
 *   1. applied to a candidate selection (its refined roots open, its coarsened roots fold);
 *   2. REVALIDATED against the HARD budgets immediately before commit (cards / layout / edges
 *      via the cut-aware quotient count / labels / gpu);
 *   3. on PASS — folded into the scene via the {@link IncrementalMaterializer} (an atomic scene
 *      mutation over only the batch's changed region) and ACCEPTED into the running committed
 *      selection;
 *   4. on FAIL — REJECTED: the candidate selection is reverted, the scene is NOT mutated, and
 *      the committed cut is left exactly as it was before the batch. A rejected batch is a pure
 *      no-op; later batches still commit (the budget is rechecked against the post-accept cut,
 *      so a rejected batch never blocks an independent one).
 *
 * Because every batch is connected over affected quotient edges (impl note (b)), the edge cost
 * each batch is validated against is the quotient graph AS THE BATCH WOULD LEAVE IT — committing
 * one connected subtree before the other can never change a co-batched edge cost mid-flight.
 *
 * The `materializer` MUST be the persistent one whose prior committed scene matches `committed`
 * (its `applyDiff` advances from that baseline). `targetGeneration` tags the produced batches.
 * Returns the final scene, the final committed selection, and each batch's outcome.
 */
export function commitTransitionBatches(input: {
  hierarchy: RepresentationHierarchy;
  edgeIndex: RepresentationEdgeIndex | undefined;
  materializer: IncrementalMaterializer;
  /** The currently-committed cut the materializer's prior scene reflects. */
  committed: LodCut;
  /** The PENDING target cut the diff is computed toward. */
  target: LodCut;
  budget: LodBudget;
  targetGeneration: number;
  /** Optional instrumentation (touched nodes/edges per applied batch). */
  counter?: MaterializeCounter;
  /** Overflow-ladder tuning (pan cap + sibling slack); defaults to {@link DEFAULT_OVERFLOW_TUNING}. */
  overflowTuning?: { maxPanRatio: number; siblingSlackW: number; siblingSlackH: number };
}): TransitionResult {
  const { hierarchy, edgeIndex, materializer, committed, target, budget, targetGeneration } = input;
  const cols = hierarchy.columns;

  const diff = diffCuts(
    committed.selectedRepresentations,
    target.selectedRepresentations,
    hierarchy.repCount,
  );
  const batches = groupTransitionBatches(diff, hierarchy, edgeIndex, targetGeneration);

  // A batch root is REFINED (its proxy opened — it grows its contents into its reservation) iff it
  // appears in the diff's `refined` set. Only refined roots can overflow their reserved box; a
  // coarsened root folds INTO one card and needs no overflow resolution.
  const refinedRoots = new Set<number>();
  for (let i = 0; i < diff.refined.length; i++) refinedRoots.add(diff.refined[i]);

  // Index the TARGET cut's selected reps by the changed-subtree ROOT whose subtree contains them
  // (a target rep falls under exactly one batch root, or none — the unchanged region). A batch's
  // candidate selection within a root is exactly these reps (exact for any tier depth).
  const rootOfTarget = new Map<number, number[]>();
  for (const batch of batches) for (const root of batch.roots) rootOfTarget.set(root, []);
  const batchRoots = [...rootOfTarget.keys()];
  for (let i = 0; i < target.selectedRepresentations.length; i++) {
    const r = target.selectedRepresentations[i];
    for (const root of batchRoots) {
      if (
        cols.entryByRep[r] >= cols.entryByRep[root] &&
        cols.exitByRep[r] <= cols.exitByRep[root]
      ) {
        rootOfTarget.get(root)!.push(r);
        break;
      }
    }
  }

  // The running committed selection — starts at the committed cut, advanced by each ACCEPTED
  // batch. A rejected batch leaves it untouched (the no-op guarantee).
  const selected = new Set<number>(committed.selectedRepresentations);

  let prevSelected = Uint32Array.from(committed.selectedRepresentations as ArrayLike<number>);
  // Establish the baseline scene reflecting the COMMITTED cut (an empty-diff fold — a no-op
  // mutation that returns the materializer's current scene, or the full baseline on the first
  // ever call). This is the scene returned UNCHANGED when every batch is rejected.
  let scene: GraphModel = materializer.applyDiff(
    { selectedRepresentations: prevSelected },
    { refined: new Uint32Array(0), coarsened: new Uint32Array(0), unchanged: prevSelected },
    input.counter,
  );
  const outcomes: BatchCommitOutcome[] = [];
  let anyCommitted = false;
  let envelopeExhausted = false;

  for (const batch of batches) {
    // Resolve overflow for each REFINED root in the batch through the SCOPED ladder (design P3
    // overflow). Every resolution is `global:false` — a refinement never triggers a global
    // relayout; the growth ceiling is the rep's envelope (representation-bounds caps it). The
    // final `scoped-relayout` rung flags an envelope exhaustion (a later, explicit global-relayout
    // request — NOT a global relayout of this transition).
    const overflow: { root: number; resolution: OverflowResolution }[] = [];
    for (let i = 0; i < batch.roots.length; i++) {
      const root = batch.roots[i];
      if (!refinedRoots.has(root)) continue; // coarsen-only root — no growth, no overflow
      const resolution = resolveBatchOverflow(cols, root, input.overflowTuning);
      overflow.push({ root, resolution });
    }

    const { added, removed } = applyBatchToSelection(cols, selected, batch, rootOfTarget);
    const rejectedBy = hardBudgetBreach(cols, edgeIndex, selected, budget);
    if (rejectedBy !== null) {
      // REJECTED — revert the candidate selection; the scene + committed cut stay unchanged.
      revertBatch(selected, added, removed);
      outcomes.push({ batch, committed: false, rejectedBy, overflow });
      continue;
    }
    // ACCEPTED — materialize the batch atomically against the running scene. The CutDiff handed
    // to the materializer is THIS batch's changes only (its added/removed reps), so the scene
    // mutation is bounded by the batch's changed region.
    const nextSelected = Uint32Array.from([...selected].sort((a, b) => a - b));
    const batchDiff = diffCuts(prevSelected, nextSelected, hierarchy.repCount);
    scene = materializer.applyDiff(
      { selectedRepresentations: nextSelected },
      batchDiff,
      input.counter,
    );
    prevSelected = nextSelected;
    anyCommitted = true;
    // A COMMITTED refined root that needed the scoped-relayout rung exhausted its envelope.
    for (const o of overflow) if (o.resolution.scopedRelayout) envelopeExhausted = true;
    outcomes.push({ batch, committed: true, rejectedBy: null, overflow });
  }

  return { scene, committedSelection: prevSelected, outcomes, anyCommitted, envelopeExhausted };
}
