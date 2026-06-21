// The Constrained LOD Cut Solver — Appendix A of the dimension-spine design (FROZEN).
// Replaces C1a's collapse-shaped cut for the RENDERED scene with a budgeted VALID
// ANTICHAIN through the RepresentationHierarchy's proxy tree.
//
// A valid antichain: every underlying node is represented EXACTLY ONCE — by an ancestor
// proxy or by descendants, never both (proxy + children) and never neither (an
// unrepresented subtree). The solver starts from a seed (bootstrap) antichain, applies
// USER INTENT AS CONSTRAINTS (forceClosed/forceOpen — §A; intent constrains the solve,
// it is not composed after it), then greedily refines the highest error-per-cost proxy
// while the SOFT budget allows; a forced open may exceed soft up to the HARD ceiling but
// nothing exceeds hard (§B). Every refine/coarsen is an ATOMIC transaction — commit or
// reject the whole transition; a rejected transition leaves the prior cut byte-identical
// (§E).
//
// Pure and deterministic — the whole solver is verified here without a GPU.

import type { RepresentationColumns, RepresentationHierarchy } from "./representation";
import { isRepAncestor } from "./representation";

/**
 * The authoritative camera-driven LOD result: a valid antichain plus its aggregated
 * costs and a generation counter (bumped by the runtime when a materially-different cut
 * is committed — see lod-runtime.ts). `selectedRepresentations` is CANONICAL (sorted
 * ascending) so two equal cuts compare equal (Appendix A §J/K).
 */
export interface LodCut {
  selectedRepresentations: Uint32Array;
  /** Visible cards (the antichain width = one per selected rep). */
  cardCost: number;
  /** Layout work (Σ (1 + symbols) over selected reps) — DISTINCT from cardCost. */
  layoutCost: number;
  edgeCost: number;
  labelCost: number;
  gpuByteCost: number;
  generation: number;
}

/**
 * User intent expressed as solver CONSTRAINTS (Appendix A §A), not post-composition.
 * `forceClosed`: select this rep (or the nearest legal ancestor) and exclude its
 * descendants. `forceOpen`: this rep may NOT stand in for its descendants — the solver
 * descends ≥1 level past it. Parent-closed beats a descendant-open (precedence).
 */
export interface CutConstraints {
  forceClosed: ReadonlySet<number>;
  forceOpen: ReadonlySet<number>;
}

/**
 * Hard vs soft budgets (Appendix A §B; finite split-budget model — design "Finite budget
 * model"). Automatic refinement never exceeds the SOFT targets; an explicit user-open may
 * exceed targets up to the HARD ceiling; nothing exceeds hard. The dimensions are SPLIT and
 * every ceiling is FINITE — `Infinity`/`totalNodes` are not limits:
 *
 * - cards: VISIBLE cards (one proxy = one card; the antichain width the user sees).
 * - layoutCost: Σ (1 + symbols) over refined reps — the relayout work pressure. DISTINCT
 *   from cards: a proxy is one card but may carry high future layout cost.
 * - edges / labels: aggregated edges + drawn labels.
 * - gpu: GPU geometry bytes.
 *
 * When intent cannot be honored within a hard ceiling, the solver surfaces a structured
 * "Detail limited" signal (see {@link LimitedDetail}) rather than expanding to the whole graph.
 */
export interface LodBudget {
  /** Soft cap on visible cards (the antichain width). */
  targetCards: number;
  /** Hard ceiling on visible cards — a forced open is capped here, never the whole graph. */
  hardCards: number;
  /** Soft cap on layout work (Σ (1 + symbols) over refined reps). */
  targetLayoutCost: number;
  /** Hard ceiling on layout work. */
  hardLayoutCost: number;
  targetEdges: number;
  hardEdges: number;
  targetLabels: number;
  hardLabels: number;
  /** GPU geometry budget (bytes). */
  maxGpuBytes: number;
}

/**
 * Example production defaults for the finite split budget (design "Finite budget model").
 * Exact numbers are pinned by the P4 bench; every ceiling is finite by construction.
 */
export const LOD_BUDGET: LodBudget = {
  // visible cards (one proxy = one card; the antichain width the user sees)
  targetCards: 800,
  hardCards: 2_000,
  // layout cost (Σ (1 + symbols) over refined reps — the relayout work pressure)
  targetLayoutCost: 2_500,
  hardLayoutCost: 6_000,
  // aggregated edges in the active quotient graph (cut-dependent; via the edge index — B2)
  targetEdges: 8_000,
  hardEdges: 25_000,
  // labels drawn
  targetLabels: 500,
  hardLabels: 2_000,
  // GPU geometry budget
  maxGpuBytes: 128 * 1024 * 1024,
};

/**
 * Why an explicit open could not be honored within the hard ceiling (design "Deterministic
 * forced-open arbitration"). The solver retains the nearest legal proxy and emits this
 * structured signal so the UI can surface an honest "Detail limited" message naming the
 * limiting budget — rather than silently expanding to the whole graph.
 */
export interface LimitedDetail {
  /** The rep the user asked to open. */
  requestedRep: number;
  /** The nearest proxy actually retained (the cut stops here). */
  resolvedRep: number;
  /** Which finite ceiling stopped the descent. */
  limitingBudget: "cards" | "edges" | "labels" | "gpu" | "layout";
}

/** Minimal camera state the solver scores against (visibility/interaction weighting). */
export interface CameraState {
  x: number;
  y: number;
  scale: number;
  viewport: { w: number; h: number };
}

/**
 * The cost vector of a cut across the budget dimensions. `cards` (visible antichain width)
 * and `layout` (Σ (1 + symbols) relayout work) are DISTINCT — a proxy is one card but may
 * carry high layout cost.
 */
interface CostVec {
  cards: number;
  edges: number;
  labels: number;
  gpu: number;
  layout: number;
}

// ── Seed cuts ────────────────────────────────────────────────────────────────

/**
 * The coarsest valid antichain: every root rep selected. Covers every node exactly once
 * (each node's path hits exactly one root). The natural bootstrap seed — "everything
 * starts as its top proxy", and the solver refines from here.
 */
export function rootCut(h: RepresentationHierarchy): LodCut {
  return cutFromSelection(h, h.roots, 0);
}

/** Alias: the bootstrap seed is the root cut (coarsest). Kept distinct for call sites. */
export function bootstrapCut(h: RepresentationHierarchy): LodCut {
  return rootCut(h);
}

/**
 * Build a {@link LodCut} from a selected-rep collection: canonicalize (sort ascending,
 * dedupe) and sum the aggregated costs. Pure — the input is not retained.
 */
export function cutFromSelection(
  h: RepresentationHierarchy,
  selection: Iterable<number>,
  generation: number,
): LodCut {
  const set = new Set<number>(selection);
  const arr = Uint32Array.from([...set].sort((a, b) => a - b));
  const cost = sumCost(h.columns, arr);
  return {
    selectedRepresentations: arr,
    cardCost: cost.cards,
    layoutCost: cost.layout,
    edgeCost: cost.edges,
    labelCost: cost.labels,
    gpuByteCost: cost.gpu,
    generation,
  };
}

function sumCost(cols: RepresentationColumns, reps: ArrayLike<number>): CostVec {
  let cards = 0;
  let edges = 0;
  let labels = 0;
  let gpu = 0;
  let layout = 0;
  for (let i = 0; i < reps.length; i++) {
    const r = reps[i];
    // Each selected rep is ONE visible card; nodeCost (1 + symbols) is LAYOUT cost, not
    // cards — the two are tracked independently (design "Finite budget model").
    cards += 1;
    layout += cols.nodeCost[r];
    edges += cols.edgeCost[r];
    labels += cols.labelCost[r];
    gpu += cols.gpuByteCost[r];
  }
  return { cards, edges, labels, gpu, layout };
}

// ── The solve ────────────────────────────────────────────────────────────────

/**
 * Why a selected proxy was not refined further (Appendix A §I observability — the per-rep
 * "why-not-refined" the dev overlay surfaces; tuning the priority blindly is otherwise
 * hopeless). `none` means it IS refined (a leaf) or simply wasn't the best candidate.
 */
export type WhyNotRefined =
  | "forced-closed" // a force-closed constraint freezes it at/above this level
  | "screen-gate" // canRefine() said no (off-screen / sub-legible)
  | "soft-budget" // refining it would exceed the soft target
  | "leaf"; // it is a leaf — nothing finer to refine

/** Optional diagnostics the solver fills for the observability overlay (§I). */
export interface SolveDiagnostics {
  /** rep id → why it wasn't refined past its level (only for still-selected non-leaf reps). */
  whyNotRefined: Map<number, WhyNotRefined>;
  /** Count of atomic refinements committed this solve. */
  refinements: number;
  /**
   * Explicit opens that hit a FINITE hard ceiling and were retained at the nearest proxy
   * ("Detail limited" — design "Deterministic forced-open arbitration"). Empty when every
   * forced open was honored within hard. The UI surfaces an honest message naming the
   * limiting budget; this is the structured field rather than a silent retain.
   */
  limited: LimitedDetail[];
}

/**
 * An optional hard refinement gate (beyond budget + force-closed). `canRefine(rep)`
 * returning false freezes a proxy at its level during AUTOMATIC refinement — used by the
 * scene bridge to stop opening off-screen / sub-legible proxies (the screen-space-error
 * cutoff the C1c `minScale` will later formalize). Forced opens IGNORE this gate (user
 * intent overrides). When absent, every selected non-leaf proxy is refinable. An optional
 * `diagnostics` sink collects the per-rep why-not-refined trace (§I).
 */
export interface SolveGate {
  canRefine?: (rep: number) => boolean;
  diagnostics?: SolveDiagnostics;
}

/**
 * Solve the constrained budgeted antichain cut (Appendix A). The returned cut is always
 * valid; it never exceeds the HARD budget; automatic refinement never exceeds the SOFT
 * targets; forced opens may exceed soft up to hard. The result is canonical.
 */
export function solveLodCut(
  h: RepresentationHierarchy,
  bootstrap: LodCut,
  constraints: CutConstraints,
  cam: CameraState,
  budget: LodBudget,
  gate?: SolveGate,
): LodCut {
  const cols = h.columns;
  // Working antichain as a Set of rep ids. Seed from the bootstrap; if empty, fall to the
  // roots (the coarsest valid antichain) so we always start from a VALID cut.
  const selected = new Set<number>(bootstrap.selectedRepresentations);
  if (selected.size === 0) for (const r of h.roots) selected.add(r);
  // Running cost vector, kept live across the constraint + refine phases.
  const cur = sumCost(cols, [...selected]);

  // 1. forceOpen (§A): a force-open rep may not be the representative. Ensure each is
  //    NOT selected and its subtree is represented by descendants. If a selected ancestor
  //    covers it, refine down until the rep is strictly below the cut. Forced opens may
  //    spend up to the FINITE HARD ceiling; one that can't descend within hard is retained
  //    at the nearest proxy and recorded as a "Detail limited" signal (§B).
  for (const rep of constraints.forceOpen) {
    const limited = forceOpenRep(cols, selected, rep, cur, budget);
    if (limited && gate?.diagnostics) gate.diagnostics.limited.push(limited);
  }

  // 2. forceClosed (§A): select the requested proxy (or nearest legal ancestor) and
  //    remove any selected descendants. Applied AFTER forceOpen so parent-closed wins
  //    over a descendant-open (the closed proxy absorbs the open descendant).
  for (const rep of constraints.forceClosed) {
    forceClosedRep(cols, selected, rep);
  }

  // forceClosedRep collapses opened descendants back into a proxy but does NOT decrement
  // `cur` (it can drop arbitrary subtrees, not a single marginal delta). After a
  // close-over-an-open the running cost is therefore STALE and overstated, which would
  // make refineUnderBudget see the budget as more spent than it is and under-refine. Recompute
  // `cur` from the post-constraint `selected` so the budget pressure is accurate (§D/E).
  const live = sumCost(cols, [...selected]);
  cur.cards = live.cards;
  cur.edges = live.edges;
  cur.labels = live.labels;
  cur.gpu = live.gpu;
  cur.layout = live.layout;

  // 3. Budget-driven refinement (§D/E): greedily refine the highest error-per-cost proxy
  //    while the SOFT budget allows. Atomic: each refine is committed only if it keeps the
  //    cut within soft budget; otherwise it is skipped (the prior cut is unchanged).
  refineUnderBudget(h, selected, cam, budget, constraints, gate, cur);

  return cutFromSelection(h, selected, bootstrap.generation);
}

/**
 * Force a rep OPEN: it may not stand in for its descendants. If the rep itself is
 * selected, refine it (replace with children). If a selected ANCESTOR covers it, refine
 * that ancestor downward until the rep is strictly below the cut. A leaf rep can't be
 * opened (no descendants) — it stays as-is (already the finest representation). Forced
 * opens spend up to the HARD ceiling; if a refinement would breach hard, retain the
 * nearest legal proxy (the "Detail limited" case — §B).
 */
function forceOpenRep(
  cols: RepresentationColumns,
  selected: Set<number>,
  rep: number,
  cur: CostVec,
  budget: LodBudget,
): LimitedDetail | null {
  if (cols.firstChildByRep[rep] === -1) return null; // a leaf can't be opened further
  let guard = cols.parentByRep.length + 1;
  while (guard-- > 0) {
    // Find the selected rep on `rep`'s path (rep itself or an ancestor). At most one
    // (antichain). If none is selected, rep is already strictly below the cut → done.
    const covering = coveringSelected(cols, selected, rep);
    if (covering === -1) return null;
    if (covering !== rep && isStrictAncestor(cols, rep, covering)) {
      // covering is a descendant of rep — already open past rep; done.
      return null;
    }
    // Refine `covering` (replace with its children), within the FINITE HARD ceiling. If it
    // can't be refined safely, STOP and surface "Detail limited": retain the nearest legal
    // proxy (`covering`) and name the finite ceiling that blocked the descent — rather than
    // expanding to the whole graph (design "Finite budget model" + "forced-open arbitration").
    if (!refineAtomic(cols, selected, covering, budget, "hard", cur)) {
      return {
        requestedRep: rep,
        resolvedRep: covering,
        limitingBudget: limitingBudgetOf(cols, covering, cur, budget),
      };
    }
    // Loop: after refining, a child may again cover rep — keep descending until rep is
    // below the cut (covering becomes rep's descendant or disappears).
    if (covering === rep) return null; // we refined rep itself → its children now cover; done
  }
  return null;
}

/**
 * The FINITE hard ceiling that blocks refining `rep` from the current cost `cur` — the
 * dimension whose post-refinement value first exceeds its hard budget. Drives the
 * "Detail limited" message's `limitingBudget` (design "forced-open arbitration"). Checked in
 * a fixed order so the reported limit is deterministic.
 */
function limitingBudgetOf(
  cols: RepresentationColumns,
  rep: number,
  cur: CostVec,
  budget: LodBudget,
): LimitedDetail["limitingBudget"] {
  const delta = marginalRefineDelta(cols, rep);
  if (cur.cards + delta.cards > budget.hardCards) return "cards";
  if (cur.layout + delta.layout > budget.hardLayoutCost) return "layout";
  if (cur.edges + delta.edges > budget.hardEdges) return "edges";
  if (cur.labels + delta.labels > budget.hardLabels) return "labels";
  if (cur.gpu + delta.gpu > budget.maxGpuBytes) return "gpu";
  return "cards"; // defensive: some ceiling blocked it; cards is the user-visible default
}

/**
 * Force a rep CLOSED: select it (the requested proxy) and remove every selected
 * descendant — it stands in for its whole subtree. Also remove the rep if a selected
 * ancestor already covers it (then that ancestor stays — a closed ancestor is at least as
 * coarse, which still excludes the descendants the user closed). Selecting the rep and
 * dropping descendants keeps the antichain valid.
 */
function forceClosedRep(cols: RepresentationColumns, selected: Set<number>, rep: number): void {
  // If a strict ancestor is already selected, it covers rep with a coarser proxy — leave
  // it (still excludes rep's descendants). Otherwise select rep itself.
  const covering = coveringSelected(cols, selected, rep);
  if (covering !== -1 && covering !== rep && isStrictAncestor(cols, covering, rep)) {
    // an ancestor proxy already represents rep's subtree; nothing finer to remove
    return;
  }
  // Remove any selected descendants of rep, then select rep.
  for (const s of [...selected]) {
    if (s !== rep && isStrictAncestor(cols, rep, s)) selected.delete(s);
  }
  selected.add(rep);
}

/**
 * Greedy error-per-cost refinement (Appendix A §D). Repeatedly pick the selected proxy
 * with the highest priority and refine it (atomic, within the SOFT budget) until no
 * beneficial refinement fits. Force-closed reps (and their ancestors-as-proxies) are
 * never refined past the closed level. Maintains a running cost vector so each iteration
 * is O(|frontier|), not O(|frontier|²) — the frontier is bounded by the budget.
 */
function refineUnderBudget(
  h: RepresentationHierarchy,
  selected: Set<number>,
  cam: CameraState,
  budget: LodBudget,
  constraints: CutConstraints,
  gate: SolveGate | undefined,
  cur: CostVec,
): void {
  const cols = h.columns;
  const canRefine = gate?.canRefine;
  const diag = gate?.diagnostics;
  // Reps whose refinement was rejected this solve (didn't fit the soft budget). A blocked
  // rep is skipped as a candidate so the loop tries the NEXT-best smaller refinement
  // instead of stopping — a too-large candidate must not strand the remaining budget.
  const blocked = new Set<number>();
  // Bound the number of refinements to the rep count (each rep is refined at most once).
  let guard = h.repCount + 1;
  while (guard-- > 0) {
    const remaining: CostVec = {
      cards: Math.max(0, budget.targetCards - cur.cards),
      edges: Math.max(0, budget.targetEdges - cur.edges),
      labels: Math.max(0, budget.targetLabels - cur.labels),
      gpu: Math.max(0, budget.maxGpuBytes - cur.gpu),
      layout: Math.max(0, budget.targetLayoutCost - cur.layout),
    };
    let best = -1;
    let bestPriority = -Infinity;
    for (const r of selected) {
      if (cols.firstChildByRep[r] === -1) continue; // a leaf can't be refined
      if (blocked.has(r)) continue; // already rejected this solve → don't reconsider
      if (isForceClosedHere(cols, constraints, r)) continue; // closed at/above r → frozen
      if (canRefine && !canRefine(r)) continue; // screen-space / legibility gate
      const p = refinePriority(cols, cam, r, remaining);
      if (p > bestPriority) {
        bestPriority = p;
        best = r;
      }
    }
    if (best === -1) break;
    // Refine the best within the SOFT budget. If it doesn't fit, BLOCK it and continue:
    // a smaller candidate may still fit the remaining budget. Stopping here would strand
    // substantial budget behind a single oversized proxy.
    if (!refineAtomic(cols, selected, best, budget, "soft", cur)) {
      blocked.add(best);
      continue;
    }
    if (diag) diag.refinements += 1;
  }
  // Per-rep why-not-refined (§I): classify every still-selected non-leaf proxy.
  if (diag) {
    for (const r of selected) {
      if (cols.firstChildByRep[r] === -1) continue; // leaf — nothing to refine
      let reason: WhyNotRefined;
      if (isForceClosedHere(cols, constraints, r)) reason = "forced-closed";
      else if (canRefine && !canRefine(r)) reason = "screen-gate";
      else reason = "soft-budget"; // selected, refinable, but budget/priority stopped it
      diag.whyNotRefined.set(r, reason);
    }
  }
}

/**
 * Atomically refine a proxy: remove it, add its children, validate the chosen budget
 * ceiling ("soft" for auto, "hard" for forced) against the running cost `cur`. Commit
 * only if valid (and update `cur` in place by the marginal delta); otherwise leave
 * `selected` and `cur` byte-identical (Appendix A §E). Returns whether it committed.
 */
function refineAtomic(
  cols: RepresentationColumns,
  selected: Set<number>,
  rep: number,
  budget: LodBudget,
  ceiling: "soft" | "hard",
  cur: CostVec,
): boolean {
  if (cols.firstChildByRep[rep] === -1) return false;
  if (!selected.has(rep)) return false;
  // Gather children and the marginal delta = Σ children − rep. CARDS and LAYOUT are tracked
  // distinctly: refining swaps 1 card (the proxy) for N cards (its children) → Δcards =
  // childCount − 1; layout is Σ child nodeCost − parent nodeCost (1 + symbols each).
  const children: number[] = [];
  const delta: CostVec = { cards: 0, edges: 0, labels: 0, gpu: 0, layout: 0 };
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) {
    children.push(c);
    delta.cards += 1;
    delta.layout += cols.nodeCost[c];
    delta.edges += cols.edgeCost[c];
    delta.labels += cols.labelCost[c];
    delta.gpu += cols.gpuByteCost[c];
  }
  delta.cards -= 1; // the proxy itself was one card
  delta.layout -= cols.nodeCost[rep];
  delta.edges -= cols.edgeCost[rep];
  delta.labels -= cols.labelCost[rep];
  delta.gpu -= cols.gpuByteCost[rep];

  const next: CostVec = {
    cards: cur.cards + delta.cards,
    edges: cur.edges + delta.edges,
    labels: cur.labels + delta.labels,
    gpu: cur.gpu + delta.gpu,
    layout: cur.layout + delta.layout,
  };
  if (!withinCeiling(next, budget, ceiling)) return false;

  // Commit: swap rep → children, advance the running cost.
  selected.delete(rep);
  for (const c of children) selected.add(c);
  cur.cards = next.cards;
  cur.edges = next.edges;
  cur.labels = next.labels;
  cur.gpu = next.gpu;
  cur.layout = next.layout;
  return true;
}

/**
 * Whether a cost vector is within the soft or hard ceiling across every FINITE budget dim.
 * GPU has a single (finite) ceiling; cards / layout / edges / labels each have a soft target
 * and a finite hard ceiling.
 */
function withinCeiling(cost: CostVec, budget: LodBudget, ceiling: "soft" | "hard"): boolean {
  if (cost.gpu > budget.maxGpuBytes) return false;
  if (ceiling === "soft") {
    return (
      cost.cards <= budget.targetCards &&
      cost.layout <= budget.targetLayoutCost &&
      cost.edges <= budget.targetEdges &&
      cost.labels <= budget.targetLabels
    );
  }
  return (
    cost.cards <= budget.hardCards &&
    cost.layout <= budget.hardLayoutCost &&
    cost.edges <= budget.hardEdges &&
    cost.labels <= budget.hardLabels
  );
}

/**
 * Priority of refining a proxy (Appendix A §D): deltaError / normalizedDeltaCost. The
 * delta-error is the information GAINED by replacing the proxy with its children (the
 * proxy's own hidden-information error); the delta-cost is the MARGINAL load of the
 * refinement (Σ children cost − parent cost — exactly what refineAtomic charges),
 * normalized by the REMAINING budget so an edge-heavy refine is deprioritized when the
 * edge budget is nearly spent. Boosted by on-screen visibility (the spec's
 * visibilityWeight).
 */
function refinePriority(
  cols: RepresentationColumns,
  cam: CameraState,
  rep: number,
  remaining: CostVec,
): number {
  const EPSILON = 1e-6;
  // deltaError ≈ the error this proxy hides (resolved by refining it). geometricError is
  // the log2 subtree-size heuristic; weight by the structural (edge) error too.
  const deltaError = cols.geometricError[rep] * (1 + cols.structuralError[rep]);
  // deltaCost = the MARGINAL one-level refinement cost: Σ over the proxy's DIRECT children
  // minus the proxy's own per-level cost (the same delta refineAtomic commits). Using the
  // parent's own per-level cost instead is wrong — every proxy renders as ONE card
  // (nodeCost 1), so a 2-child and a 2000-child proxy would look identically cheap. The
  // marginal delta separates them: refining a 2000-child proxy adds ~2000 cards, a 2-child
  // proxy adds ~2.
  const delta = marginalRefineDelta(cols, rep);
  const normCost = normalizedCost(delta, remaining);
  const visibility = visibilityWeight(cols, cam, rep);
  return (deltaError * visibility) / Math.max(EPSILON, normCost);
}

/**
 * The marginal cost of refining a proxy one level: Σ over its DIRECT children of each
 * rendered per-level cost, minus the proxy's own per-level cost. Mirrors the delta
 * refineAtomic commits, so priority normalization and the actual budget charge agree.
 */
function marginalRefineDelta(cols: RepresentationColumns, rep: number): CostVec {
  let cards = 0;
  let layout = 0;
  let edges = 0;
  let labels = 0;
  let gpu = 0;
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) {
    cards += 1;
    layout += cols.nodeCost[c];
    edges += cols.edgeCost[c];
    labels += cols.labelCost[c];
    gpu += cols.gpuByteCost[c];
  }
  cards -= 1; // the proxy itself was one card
  layout -= cols.nodeCost[rep];
  edges -= cols.edgeCost[rep];
  labels -= cols.labelCost[rep];
  gpu -= cols.gpuByteCost[rep];
  // Same delta refineAtomic commits — cards (childCount − 1) and layout (Σ child − parent)
  // are distinct dimensions (design "Finite budget model").
  return { cards, layout, edges, labels, gpu };
}

/** max over dims of delta[d] / max(1, remaining[d]) (Appendix A §D). */
function normalizedCost(delta: CostVec, remaining: CostVec): number {
  return Math.max(
    delta.cards / Math.max(1, remaining.cards),
    delta.edges / Math.max(1, remaining.edges),
    delta.labels / Math.max(1, remaining.labels),
    delta.gpu / Math.max(1, remaining.gpu),
    delta.layout / Math.max(1, remaining.layout),
  );
}

/**
 * Visibility weight (Appendix A §D, starting heuristic). A proxy whose world bounds are
 * on screen is worth more to refine than an off-screen one. When the hierarchy carries no
 * geometry yet (C1c fills bounds), every rep weighs 1 — so the solver still behaves
 * sensibly before stable layout lands.
 */
function visibilityWeight(cols: RepresentationColumns, cam: CameraState, rep: number): number {
  const w = cols.boundsW[rep];
  const hgt = cols.boundsH[rep];
  if (w <= 0 || hgt <= 0) return 1; // no geometry → neutral
  const left = cols.boundsX[rep] * cam.scale + cam.x;
  const top = cols.boundsY[rep] * cam.scale + cam.y;
  const right = left + w * cam.scale;
  const bottom = top + hgt * cam.scale;
  const onScreen = right >= 0 && left <= cam.viewport.w && bottom >= 0 && top <= cam.viewport.h;
  return onScreen ? 2 : 0.25;
}

// ── antichain helpers ────────────────────────────────────────────────────────

/**
 * The single selected rep on `rep`'s root→leaf path (rep itself or one of its ancestors),
 * or -1 if none. In a valid antichain at most one such rep exists. Walks ancestors.
 */
function coveringSelected(cols: RepresentationColumns, selected: Set<number>, rep: number): number {
  let cur = rep;
  let guard = cols.parentByRep.length + 1;
  // `>= 0` stops on -1 (root) AND -2 (DETACHED_REP, a fully-hidden rep under the post-filter
  // mask); a detached rep is never in `selected`, so it covers nothing.
  while (cur >= 0 && guard-- > 0) {
    if (selected.has(cur)) return cur;
    cur = cols.parentByRep[cur];
  }
  return -1;
}

/** True when `a` is a STRICT ancestor of `b` (a ≠ b and a's interval contains b's). */
function isStrictAncestor(cols: RepresentationColumns, a: number, b: number): boolean {
  return a !== b && isRepAncestor(cols, a, b);
}

/**
 * True when a force-closed constraint freezes `rep` from refining: rep itself is
 * force-closed, or a force-closed rep is an ancestor of rep (the closed proxy stands in,
 * so rep — below it — is never independently refined). Parent-closed wins.
 */
function isForceClosedHere(
  cols: RepresentationColumns,
  constraints: CutConstraints,
  rep: number,
): boolean {
  for (const fc of constraints.forceClosed) {
    if (fc === rep) return true;
    if (isRepAncestor(cols, fc, rep)) return true; // a closed ancestor covers rep
  }
  return false;
}

// ── Runtime cut: O(1) membership (Appendix A §J) ─────────────────────────────

/**
 * An O(1) "is this rep selected?" view over a {@link LodCut} (Appendix A §J). The hot
 * `representativeOf` walk must test membership without scanning `selectedRepresentations`
 * and without clearing a giant bitset every generation — so each rep stores the EPOCH it
 * was last selected in, and membership is `selectedEpoch[rep] === epoch`.
 */
export interface RuntimeLodCut {
  canonical: LodCut;
  selectedEpoch: Uint32Array;
  epoch: number;
  isSelected: (rep: number) => boolean;
}

/** A monotonic epoch source so a fresh runtime cut never collides with a prior one. */
let epochCounter = 0;

/**
 * Build a {@link RuntimeLodCut} for O(1) membership. `repCount` sizes the epoch array.
 * The epoch is globally monotonic, so reusing the array across generations needs no
 * clear — a stale entry simply doesn't match the current epoch.
 */
export function makeRuntimeCut(cut: LodCut, repCount: number): RuntimeLodCut {
  epochCounter += 1;
  const epoch = epochCounter;
  const selectedEpoch = new Uint32Array(repCount);
  for (const r of cut.selectedRepresentations) selectedEpoch[r] = epoch;
  const isSelected = (rep: number) => selectedEpoch[rep] === epoch;
  return { canonical: cut, selectedEpoch, epoch, isSelected };
}

/**
 * Update an existing {@link RuntimeLodCut} in place for a new cut — reuses the epoch
 * array (no realloc, no clear) by bumping the epoch. The hot-path eviction-free way to
 * roll a runtime cut forward each committed generation.
 */
export function advanceRuntimeCut(rt: RuntimeLodCut, cut: LodCut): RuntimeLodCut {
  epochCounter += 1;
  rt.epoch = epochCounter;
  for (const r of cut.selectedRepresentations) rt.selectedEpoch[r] = rt.epoch;
  rt.canonical = cut;
  // Re-bind isSelected to read the current epoch (closure already references rt.epoch via
  // the array+epoch — but isSelected captured the old epoch value, so rebuild it).
  rt.isSelected = (rep: number) => rt.selectedEpoch[rep] === rt.epoch;
  return rt;
}

// ── Material cut equality (Appendix A §K) ────────────────────────────────────

/**
 * A signature that captures everything a RENDERER update depends on (Appendix A §K):
 * identical node selection with a different edge/label degradation stage STILL needs a
 * redraw, so equality is more than the selected-rep hash. The runtime commits a new
 * generation only when this signature changes (lod-runtime.ts).
 */
export interface CutSignature {
  selectedRepresentationsHash: bigint;
  edgeLodStage: number;
  labelLodStage: number;
  filterSignature: string;
}

/**
 * A stable 64-bit (bigint) hash of the canonical selected-rep array (an FNV-1a over the
 * sorted rep ids). Because `selectedRepresentations` is canonical, equal cuts hash equal.
 * bigint (not a JS number) so the full 64 bits are exact — no float precision loss.
 */
export function selectedRepresentationsHash(cut: LodCut): bigint {
  const MASK = (1n << 64n) - 1n;
  let h = 1469598103934665603n; // FNV-1a 64-bit offset basis
  const prime = 1099511628257n;
  const reps = cut.selectedRepresentations;
  for (let i = 0; i < reps.length; i++) {
    // Mix each rep id byte-wise so different orderings (there are none — canonical) and
    // different ids diverge. Fold the 32-bit rep into the 64-bit accumulator.
    h = ((h ^ BigInt(reps[i])) * prime) & MASK;
  }
  // Fold the length too, so [] and [0] (which hash the basis vs basis^0) can't collide
  // with a different-length cut whose mixing happens to land on the basis.
  h = ((h ^ BigInt(reps.length)) * prime) & MASK;
  return h;
}

/** Build a {@link CutSignature} from a cut + the current edge/label stages + filters. */
export function cutSignature(
  cut: LodCut,
  edgeLodStage: number,
  labelLodStage: number,
  filterSignature: string,
): CutSignature {
  return {
    selectedRepresentationsHash: selectedRepresentationsHash(cut),
    edgeLodStage,
    labelLodStage,
    filterSignature,
  };
}

/** Material equality of two cut signatures (drives committed-generation gating §K). */
export function cutSignaturesEqual(a: CutSignature, b: CutSignature): boolean {
  return (
    a.selectedRepresentationsHash === b.selectedRepresentationsHash &&
    a.edgeLodStage === b.edgeLodStage &&
    a.labelLodStage === b.labelLodStage &&
    a.filterSignature === b.filterSignature
  );
}
