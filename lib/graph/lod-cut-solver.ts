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
  nodeCost: number;
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
 * Hard vs soft budgets (Appendix A §B). Automatic refinement never exceeds the SOFT
 * targets; an explicit user-open may exceed targets up to the HARD ceiling; nothing
 * exceeds hard. Node / edge / label / GPU / layout-work are independent.
 */
export interface LodBudget {
  targetNodes: number;
  targetEdges: number;
  targetLabels: number;
  hardNodes: number;
  hardEdges: number;
  hardLabels: number;
  maxGpuBytes: number;
  maxLayoutWork: number;
}

/** Minimal camera state the solver scores against (visibility/interaction weighting). */
export interface CameraState {
  x: number;
  y: number;
  scale: number;
  viewport: { w: number; h: number };
}

/** The cost vector of a cut across the budget dimensions. */
interface CostVec {
  nodes: number;
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
    nodeCost: cost.nodes,
    edgeCost: cost.edges,
    labelCost: cost.labels,
    gpuByteCost: cost.gpu,
    generation,
  };
}

function sumCost(cols: RepresentationColumns, reps: ArrayLike<number>): CostVec {
  let nodes = 0;
  let edges = 0;
  let labels = 0;
  let gpu = 0;
  for (let i = 0; i < reps.length; i++) {
    const r = reps[i];
    nodes += cols.nodeCost[r];
    edges += cols.edgeCost[r];
    labels += cols.labelCost[r];
    gpu += cols.gpuByteCost[r];
  }
  // Layout work proxied by node cost (each refined proxy lays out its children).
  return { nodes, edges, labels, gpu, layout: nodes };
}

// ── The solve ────────────────────────────────────────────────────────────────

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
  //    spend up to the HARD ceiling.
  for (const rep of constraints.forceOpen) {
    forceOpenRep(cols, selected, rep, cur, budget);
  }

  // 2. forceClosed (§A): select the requested proxy (or nearest legal ancestor) and
  //    remove any selected descendants. Applied AFTER forceOpen so parent-closed wins
  //    over a descendant-open (the closed proxy absorbs the open descendant).
  for (const rep of constraints.forceClosed) {
    forceClosedRep(cols, selected, rep);
  }

  // 3. Budget-driven refinement (§D/E): greedily refine the highest error-per-cost proxy
  //    while the SOFT budget allows. Atomic: each refine is committed only if it keeps the
  //    cut within soft budget; otherwise it is skipped (the prior cut is unchanged).
  refineUnderBudget(h, selected, cam, budget, constraints);

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
): void {
  if (cols.firstChildByRep[rep] === -1) return; // a leaf can't be opened further
  let guard = cols.parentByRep.length + 1;
  while (guard-- > 0) {
    // Find the selected rep on `rep`'s path (rep itself or an ancestor). At most one
    // (antichain). If none is selected, rep is already strictly below the cut → done.
    const covering = coveringSelected(cols, selected, rep);
    if (covering === -1) return;
    if (covering !== rep && isStrictAncestor(cols, rep, covering)) {
      // covering is a descendant of rep — already open past rep; done.
      return;
    }
    // Refine `covering` (replace with its children), within the HARD ceiling. If it can't
    // be refined safely, stop (retain the nearest legal proxy — the "Detail limited" case).
    if (!refineAtomic(cols, selected, covering, budget, "hard", cur)) return;
    // Loop: after refining, a child may again cover rep — keep descending until rep is
    // below the cut (covering becomes rep's descendant or disappears).
    if (covering === rep) return; // we refined rep itself → its children now cover; done
  }
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
): void {
  const cols = h.columns;
  const cur = sumCost(cols, [...selected]); // running cost, updated on each commit
  // Bound the number of refinements to the rep count (each rep is refined at most once).
  let guard = h.repCount + 1;
  while (guard-- > 0) {
    const remaining: CostVec = {
      nodes: Math.max(0, budget.targetNodes - cur.nodes),
      edges: Math.max(0, budget.targetEdges - cur.edges),
      labels: Math.max(0, budget.targetLabels - cur.labels),
      gpu: Math.max(0, budget.maxGpuBytes - cur.gpu),
      layout: Math.max(0, budget.maxLayoutWork - cur.layout),
    };
    let best = -1;
    let bestPriority = -Infinity;
    for (const r of selected) {
      if (cols.firstChildByRep[r] === -1) continue; // a leaf can't be refined
      if (isForceClosedHere(cols, constraints, r)) continue; // closed at/above r → frozen
      const p = refinePriority(cols, cam, r, remaining);
      if (p > bestPriority) {
        bestPriority = p;
        best = r;
      }
    }
    if (best === -1) break;
    // Refine the best within the SOFT budget; if it doesn't fit, no further auto
    // refinement is beneficial under the current pressure → stop.
    if (!refineAtomic(cols, selected, best, budget, "soft", cur)) break;
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
  // Gather children and the marginal delta = Σ children − rep (rendered per-level costs).
  const children: number[] = [];
  const delta: CostVec = { nodes: 0, edges: 0, labels: 0, gpu: 0, layout: 0 };
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) {
    children.push(c);
    delta.nodes += cols.nodeCost[c];
    delta.edges += cols.edgeCost[c];
    delta.labels += cols.labelCost[c];
    delta.gpu += cols.gpuByteCost[c];
  }
  delta.nodes -= cols.nodeCost[rep];
  delta.edges -= cols.edgeCost[rep];
  delta.labels -= cols.labelCost[rep];
  delta.gpu -= cols.gpuByteCost[rep];
  delta.layout = delta.nodes; // layout work tracks node cost

  const next: CostVec = {
    nodes: cur.nodes + delta.nodes,
    edges: cur.edges + delta.edges,
    labels: cur.labels + delta.labels,
    gpu: cur.gpu + delta.gpu,
    layout: cur.layout + delta.layout,
  };
  if (!withinCeiling(next, budget, ceiling)) return false;

  // Commit: swap rep → children, advance the running cost.
  selected.delete(rep);
  for (const c of children) selected.add(c);
  cur.nodes = next.nodes;
  cur.edges = next.edges;
  cur.labels = next.labels;
  cur.gpu = next.gpu;
  cur.layout = next.layout;
  return true;
}

/** Whether a cost vector is within the soft or hard ceiling across every budget dim. */
function withinCeiling(cost: CostVec, budget: LodBudget, ceiling: "soft" | "hard"): boolean {
  if (cost.gpu > budget.maxGpuBytes) return false;
  if (cost.layout > budget.maxLayoutWork) return false;
  if (ceiling === "soft") {
    return (
      cost.nodes <= budget.targetNodes &&
      cost.edges <= budget.targetEdges &&
      cost.labels <= budget.targetLabels
    );
  }
  return (
    cost.nodes <= budget.hardNodes &&
    cost.edges <= budget.hardEdges &&
    cost.labels <= budget.hardLabels
  );
}

/**
 * Priority of refining a proxy (Appendix A §D): deltaError / normalizedDeltaCost. The
 * delta-error is the information GAINED by replacing the proxy with its children (the
 * proxy's own hidden-information error); the delta-cost is the added load, normalized by
 * the REMAINING budget so an edge-heavy refine is deprioritized when the edge budget is
 * nearly spent. Boosted by on-screen visibility (the spec's visibilityWeight).
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
  // deltaCost: children − parent across dims. node/edge/label totals are conserved on a
  // refine (children sum to the parent), so the marginal layout cost is the children's
  // own layout work; model it as the proxy's node cost (its subtree size) so larger
  // subtrees cost more to open — keeping the normalization meaningful.
  const delta: CostVec = {
    nodes: cols.nodeCost[rep],
    edges: cols.edgeCost[rep],
    labels: cols.labelCost[rep],
    gpu: cols.gpuByteCost[rep],
    layout: cols.nodeCost[rep],
  };
  const normCost = normalizedCost(delta, remaining);
  const visibility = visibilityWeight(cols, cam, rep);
  return (deltaError * visibility) / Math.max(EPSILON, normCost);
}

/** max over dims of delta[d] / max(1, remaining[d]) (Appendix A §D). */
function normalizedCost(delta: CostVec, remaining: CostVec): number {
  return Math.max(
    delta.nodes / Math.max(1, remaining.nodes),
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
  while (cur !== -1 && guard-- > 0) {
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
