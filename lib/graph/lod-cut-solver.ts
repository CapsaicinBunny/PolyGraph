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
import type { RepresentationEdgeIndex } from "./representation-edge-index";

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
 *
 * `arbitration` (optional) pins the DETERMINISTIC order in which `forceOpen` reps are
 * honored when they jointly exceed a hard budget (design "Deterministic forced-open
 * arbitration"). Without it, `forceOpen` is a Set and its iteration order is insertion-
 * dependent — so WHICH open wins the budget (and which hits "Detail limited") would be
 * non-deterministic. The solver always sorts `forceOpen` by this total order before
 * honoring it; even when `arbitration` is omitted the fallback (viewport-center proximity
 * then stable rep id) is fully deterministic regardless of Set iteration order.
 */
export interface CutConstraints {
  forceClosed: ReadonlySet<number>;
  forceOpen: ReadonlySet<number>;
  arbitration?: ForceOpenArbitration;
}

/**
 * The priority SIGNALS that order competing forced opens (design "Deterministic forced-open
 * arbitration", spec point 7). All fields are OPTIONAL — every missing signal simply doesn't
 * discriminate, and the final two tiers (viewport-center proximity, stable rep id) are
 * always computable, so arbitration is total and deterministic with or without these. The
 * total priority order is:
 *
 *   1. the currently-CLICKED open request (`clicked`),
 *   2. the SELECTED / highlighted path — incl. Problems-panel focusedIds (`highlightedPath`),
 *   3. MOST-RECENTLY-INTERACTED (`recency`: higher value = more recent),
 *   4. VIEWPORT-CENTER proximity (computed from `cam` + the rep's bounds),
 *   5. STABLE rep id (ascending — the final, fully-deterministic tiebreak).
 *
 * Higher priority is honored FIRST, so it wins the budget; a lower-priority open that no
 * longer fits within the hard ceiling is the one that surfaces "Detail limited".
 */
export interface ForceOpenArbitration {
  /** The rep the user just clicked to open (highest priority). */
  clicked?: number;
  /** Reps on the selected / highlighted path (incl. Problems-panel `focusedIds`). */
  highlightedPath?: ReadonlySet<number>;
  /**
   * Per-rep recency of interaction — a higher value is MORE recent (a monotonic counter or
   * timestamp). Reps absent from the map are treated as least-recent (−∞).
   */
  recency?: ReadonlyMap<number, number>;
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

// The production budget defaults (the single finite LOD_BUDGET source) live in
// ./lod-representation-cut alongside the scene bridge that owns the cut's budget surface
// (P4 budget-consolidation). The solver only defines the {@link LodBudget} SHAPE and consumes
// a budget passed in by its caller — it deliberately holds no concrete numbers, so there is
// exactly ONE place those numbers are written. Importers that previously took `LOD_BUDGET`
// from here now import it from ./lod-representation-cut.

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
 *
 * BOOTSTRAP FEASIBILITY (design B1). `rootCut` selects EVERY `h.roots` entry, so its card
 * cost is `h.roots.length`. WITHOUT the builder's bootstrap normalization, a high-orphan
 * graph has O(nodeCount) roots (every NO_GROUP orphan leaf + every group root is its own
 * root) — so the coarsest cut starts OVER the hard budget and, since refinement only ADDS
 * cards, can never become feasible. WITH normalization (`bootstrapRoots: true` on the
 * builder), the natural roots are adopted by a bounded synthetic super-root / root-bucket
 * tier, so `h.roots` is the single super-root and this cut is exactly one card — always
 * within `hardCards`. `rootCut` itself is unchanged; feasibility is a property of the
 * normalized hierarchy it reads.
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

// ── Deterministic forced-open arbitration (design point 7 / "forced-open arbitration") ──

/**
 * Order `forceOpen` reps by the TOTAL priority order (design "Deterministic forced-open
 * arbitration"). The returned array is the deterministic sequence in which the solver
 * honors the opens — higher priority FIRST (so it wins a contested budget). Pure: the input
 * Set is not mutated, and the result depends ONLY on the reps + signals + camera/geometry,
 * NEVER on the Set's iteration order. When two opens jointly exceed a hard budget, the one
 * earlier in this order is honored and the later one surfaces "Detail limited".
 *
 * Tiers (most significant first):
 *   1. clicked              — exactly the `arbitration.clicked` rep
 *   2. highlighted path     — membership in `arbitration.highlightedPath`
 *   3. recency              — `arbitration.recency` value, higher = more recent
 *   4. viewport-center      — proximity of the rep's bounds centre to the viewport centre
 *   5. stable rep id        — ascending (the final, fully-deterministic tiebreak)
 */
export function arbitrateForceOpen(
  cols: RepresentationColumns,
  cam: CameraState,
  forceOpen: ReadonlySet<number>,
  arbitration?: ForceOpenArbitration,
): number[] {
  const reps = [...forceOpen];
  // Precompute the viewport-centre distance per rep once (tier 4) so the comparator is O(1).
  const centreDist = new Map<number, number>();
  const vpCx = cam.viewport.w / 2;
  const vpCy = cam.viewport.h / 2;
  for (const r of reps) {
    centreDist.set(r, viewportCentreDistance(cols, cam, r, vpCx, vpCy));
  }
  const clicked = arbitration?.clicked;
  const highlighted = arbitration?.highlightedPath;
  const recency = arbitration?.recency;
  // Sort by the descending priority order. We return a NEW array; ties fall through to the
  // stable rep id, so the order is total and Set-iteration-independent.
  reps.sort((a, b) => {
    // 1. clicked — the single just-clicked open wins outright.
    const ca = clicked !== undefined && a === clicked ? 1 : 0;
    const cb = clicked !== undefined && b === clicked ? 1 : 0;
    if (ca !== cb) return cb - ca; // clicked first
    // 2. selected / highlighted path (incl. Problems-panel focusedIds).
    const ha = highlighted?.has(a) ? 1 : 0;
    const hb = highlighted?.has(b) ? 1 : 0;
    if (ha !== hb) return hb - ha; // highlighted first
    // 3. most-recently-interacted (higher recency value = more recent → first). A missing OR
    //    non-finite (NaN/±∞ from a malformed counter) recency normalizes to "least recent" so
    //    the comparator can never return NaN — a NaN result makes Array.sort order-dependent,
    //    which would reintroduce exactly the Set-iteration non-determinism this function exists
    //    to kill. We compare with `<`/`>` (not subtraction) so even equal-magnitude infinities
    //    fall through cleanly to the next tier.
    const ra = recencyValue(recency, a);
    const rb = recencyValue(recency, b);
    if (ra > rb) return -1; // a more recent → first
    if (ra < rb) return 1; // b more recent → first
    // 4. viewport-center proximity (smaller distance = nearer the centre → first). Distances are
    //    finite or +∞ (geometry-less) by construction; compare with `<`/`>` so an +∞ vs +∞ tie
    //    falls through rather than yielding NaN.
    const da = centreDist.get(a) ?? Number.POSITIVE_INFINITY;
    const db = centreDist.get(b) ?? Number.POSITIVE_INFINITY;
    if (da < db) return -1; // a nearer the centre → first
    if (da > db) return 1; // b nearer the centre → first
    // 5. stable rep id — the fully-deterministic final tiebreak (ascending).
    return a - b;
  });
  return reps;
}

/**
 * The recency of `rep` for arbitration tier 3, normalized so the comparator stays a TOTAL order.
 * A missing entry is least-recent (−∞). A present-but-non-finite value (NaN from a malformed
 * counter, or ±∞) ALSO collapses to −∞ — otherwise `NaN` would leak into the comparator and make
 * `Array.sort`'s result depend on the input order, reintroducing the very Set-iteration
 * non-determinism this module eliminates. (A legitimately huge finite timestamp is preserved.)
 */
function recencyValue(recency: ReadonlyMap<number, number> | undefined, rep: number): number {
  const v = recency?.get(rep);
  if (v === undefined || !Number.isFinite(v)) return Number.NEGATIVE_INFINITY;
  return v;
}

/**
 * Screen-space distance from a rep's bounds centre to the viewport centre (arbitration tier
 * 4). A rep with no geometry yet (zero bounds — geometry is filled later) returns +∞ so it
 * sorts AFTER every positioned rep but still ahead of nothing (the stable-id tiebreak then
 * orders the geometry-less reps deterministically).
 */
function viewportCentreDistance(
  cols: RepresentationColumns,
  cam: CameraState,
  rep: number,
  vpCx: number,
  vpCy: number,
): number {
  const w = cols.boundsW[rep];
  const hgt = cols.boundsH[rep];
  if (w <= 0 || hgt <= 0) return Number.POSITIVE_INFINITY; // no geometry → least proximate
  const cx = (cols.boundsX[rep] + w / 2) * cam.scale + cam.x;
  const cy = (cols.boundsY[rep] + hgt / 2) * cam.scale + cam.y;
  const dx = cx - vpCx;
  const dy = cy - vpCy;
  const d2 = dx * dx + dy * dy; // squared distance — monotonic, avoids a sqrt
  // Guard against NaN/∞ leaking from malformed bounds or camera (NaN would make the comparator
  // return NaN → order-dependent sort). A non-finite distance is treated as "no geometry" (+∞).
  return Number.isFinite(d2) ? d2 : Number.POSITIVE_INFINITY;
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
  /**
   * The persistent cut-aware edge index (design B2 + impl note (a)). When supplied, the
   * solver's edge gate prices a `parent → children` refinement by its ACTUAL marginal delta
   * in the active quotient graph — the cross-boundary edges that become newly-visible when
   * the children are co-selected — rather than the inert additive per-rep `edgeCost` (which
   * defaults to 0, making the edge budget effectively dead). `refineAtomic` consults this Δ
   * so a node-cheap refinement that EXPLODES the visible edge count is rejected by `hardEdges`
   * (auto refinement) / capped by it (forced opens). The delta is computed from the children's
   * boundary summaries, so it stays LOCAL to the refined region (no scan of all ~1.3M edges).
   * Omitted → the legacy additive per-rep edge cost stands in (the prior behavior).
   */
  edgeIndex?: RepresentationEdgeIndex;
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
  //
  //    The opens are honored in a DETERMINISTIC priority order (design "Deterministic
  //    forced-open arbitration"), NOT the `forceOpen` Set's insertion order. When several
  //    opens jointly exceed the hard budget, the higher-priority ones spend the budget first
  //    and the lower-priority ones surface "Detail limited" — and that outcome is identical
  //    regardless of how the Set happened to be built.
  const orderedOpens = arbitrateForceOpen(
    cols,
    cam,
    constraints.forceOpen,
    constraints.arbitration,
  );
  for (const rep of orderedOpens) {
    const limited = forceOpenRep(cols, selected, rep, cur, budget, gate?.edgeIndex);
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
  // EDGE dimension (design B2): with a cut-aware edge index the running edge cost is the
  // visible QUOTIENT-graph edge count of the CURRENT selection, not the additive per-rep sum
  // (which is the inert default 0). A forceClosed/forceOpen pass can move the selection
  // arbitrarily, so recompute the quotient edge count directly from `selected` here — it is
  // O(boundary entries over the selected reps), still local to the active tiers. Without an
  // index, fall back to the additive sum (the legacy behavior).
  cur.edges = gate?.edgeIndex ? quotientEdgeCount(gate.edgeIndex, cols, selected) : live.edges;
  cur.labels = live.labels;
  cur.gpu = live.gpu;
  cur.layout = live.layout;

  // 3. Budget-driven refinement (§D/E): greedily refine the highest error-per-cost proxy
  //    while the SOFT budget allows. Atomic: each refine is committed only if it keeps the
  //    cut within soft budget; otherwise it is skipped (the prior cut is unchanged).
  refineUnderBudget(h, selected, cam, budget, constraints, gate, cur);

  const result = cutFromSelection(h, selected, bootstrap.generation);
  // `cutFromSelection` sums the ADDITIVE per-rep edgeCost (the inert default 0). When a cut-aware
  // edge index drove the solve, the meaningful figure is the visible QUOTIENT-graph edge count —
  // which `cur.edges` has tracked exactly (seeded from the post-constraint selection, advanced by
  // each refine's marginal Δedges). Surface it as the cut's `edgeCost` so the budget readouts /
  // observability overlay report the real cut-dependent edge load, not 0 (design B2).
  if (gate?.edgeIndex) result.edgeCost = cur.edges;
  return result;
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
  edgeIndex: RepresentationEdgeIndex | undefined,
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
    if (!refineAtomic(cols, selected, covering, budget, "hard", cur, edgeIndex)) {
      return {
        requestedRep: rep,
        resolvedRep: covering,
        limitingBudget: limitingBudgetOf(cols, selected, covering, cur, budget, edgeIndex),
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
  selected: ReadonlySet<number>,
  rep: number,
  cur: CostVec,
  budget: LodBudget,
  edgeIndex: RepresentationEdgeIndex | undefined,
): LimitedDetail["limitingBudget"] {
  const delta = marginalRefineDelta(cols, rep);
  // The EDGE dimension's delta is the cut-aware quotient-graph marginal when an index is
  // present (design B2), NOT the additive per-rep edgeCost — so an open blocked by an edge
  // explosion is correctly attributed to the `edges` budget. `marginalRefineDelta` carries
  // the additive edge delta only; recompute the edge delta here from the index (against the
  // live cut, since the marginal quotient Δ is cut-dependent).
  const edgeDelta = edgeIndex
    ? marginalQuotientEdgeDelta(edgeIndex, cols, selected, rep)
    : delta.edges;
  if (cur.cards + delta.cards > budget.hardCards) return "cards";
  if (cur.layout + delta.layout > budget.hardLayoutCost) return "layout";
  if (cur.edges + edgeDelta > budget.hardEdges) return "edges";
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
      const p = refinePriority(cols, cam, selected, r, remaining, gate?.edgeIndex);
      if (p > bestPriority) {
        bestPriority = p;
        best = r;
      }
    }
    if (best === -1) break;
    // Refine the best within the SOFT budget. If it doesn't fit, BLOCK it and continue:
    // a smaller candidate may still fit the remaining budget. Stopping here would strand
    // substantial budget behind a single oversized proxy.
    if (!refineAtomic(cols, selected, best, budget, "soft", cur, gate?.edgeIndex)) {
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
  edgeIndex: RepresentationEdgeIndex | undefined,
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

  // EDGE budget (design B2): when a cut-aware edge index is present, the edge delta is the
  // ACTUAL marginal change in the active quotient graph — the cross-boundary edges among `rep`'s
  // children that become newly-visible once both children are co-selected (two siblings that
  // shared one aggregated edge under the parent become two distinct quotient edges when opened).
  // This REPLACES the inert additive per-rep `edgeCost` (default 0): a node-cheap refine that
  // explodes boundary edges is now charged its real Δedges and rejected by the ceiling. The
  // delta reads only the children's boundary summaries → local to the refined region.
  if (edgeIndex) delta.edges = marginalQuotientEdgeDelta(edgeIndex, cols, selected, rep);

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
  selected: ReadonlySet<number>,
  rep: number,
  remaining: CostVec,
  edgeIndex: RepresentationEdgeIndex | undefined,
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
  // The EDGE dim of the normalized cost reads the cut-aware quotient delta (design B2) when an
  // index is present — so a refine that explodes cross-child edges is deprioritized exactly as
  // the edge budget fills, matching what refineAtomic will charge (priority + charge agree).
  if (edgeIndex) delta.edges = marginalQuotientEdgeDelta(edgeIndex, cols, selected, rep);
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

/**
 * The TRUE marginal QUOTIENT-graph edge delta of refining `parent` (currently the selected
 * representative) into its direct children (design B2 "Marginal edge delta"):
 * `Δedges = edgesAfter − edgesBefore`, evaluated against the LIVE `selected` cut and computed
 * LOCALLY from the edge index — no scan of all edges.
 *
 * The earlier "distinct cross-child boundary pairs" formula was WRONG: it only counted edges
 * INTERNAL to `parent` that cross between two direct children, and it dismissed the external-split
 * term as a corner case. In fact that term is dominant — an edge from a node under `parent` to an
 * EXTERNAL co-selected rep `X` is represented `{parent, X}` BEFORE the refine and `{childOf(parent),
 * X}` AFTER, and several children each connecting to `X` yield several distinct new quotient edges.
 * Across a multi-tier refinement the boundary-pair sum diverged badly from the real quotient count
 * (e.g. a 64-leaf clique under intermediate tiers: 993 summed vs 2016 actual), so a cross-subtree
 * explosion slipped straight past `hardEdges` — defeating B2's whole purpose.
 *
 * CORRECT + LOCAL. Refining `parent` changes the representative ONLY of nodes under `parent` (from
 * `parent` to the appropriate direct child). So the only quotient edges that change are those with
 * AT LEAST ONE endpoint under `parent` — and every such indexed edge is registered in the index's
 * incidence CSR under `parent`, under one of `parent`'s direct children (internal cross-child
 * edges), or under an ANCESTOR of `parent` (edges whose lowest-relevant pair sits above `parent`).
 * We gather exactly those candidate edges (bounded by `parent`'s fan-out + ancestor depth, NOT all
 * edges), count their DISTINCT representative pairs BEFORE (parent-side endpoint → `parent`) and
 * AFTER (parent-side endpoint → its direct child), and return after − before. Pairs touching the
 * changed region are disjoint from every unaffected edge's pair, so this local Δ equals the exact
 * global quotient delta.
 */
function marginalQuotientEdgeDelta(
  index: RepresentationEdgeIndex,
  cols: RepresentationColumns,
  selected: ReadonlySet<number>,
  parent: number,
): number {
  const { incidentOffsets, incidentEntries, edgeSrcLeaf, edgeDstLeaf } = index;
  if (parent + 1 >= incidentOffsets.length) return 0; // stale index vs hierarchy — defensive

  // Gather the candidate reps whose incidence slices hold every edge that can change: `parent`
  // itself, each direct child (internal cross-child edges), and the ancestor chain (external
  // edges whose lowest-relevant pair sits above `parent`). De-duped so an edge entry registered
  // under two candidate reps is visited once via the `seenEntry` guard below.
  const candidateReps: number[] = [parent];
  for (let c = cols.firstChildByRep[parent]; c !== -1; c = cols.nextSiblingByRep[c]) {
    candidateReps.push(c);
  }
  {
    let anc = cols.parentByRep[parent];
    let guard = cols.parentByRep.length + 1;
    while (anc >= 0 && guard-- > 0) {
      candidateReps.push(anc);
      anc = cols.parentByRep[anc];
    }
  }

  // The direct child of `parent` that represents a leaf endpoint AFTER the refine (the leaf's
  // ancestor-or-self whose parent is `parent`), or -1 if the leaf is not under `parent`.
  const childUnderParent = (leaf: number): number => {
    let cur = leaf;
    let guard = cols.parentByRep.length + 1;
    while (cur >= 0 && guard-- > 0) {
      if (cols.parentByRep[cur] === parent) return cur;
      cur = cols.parentByRep[cur];
    }
    return -1;
  };

  const before = new Set<number>();
  const after = new Set<number>();
  const seenEntry = new Set<number>();
  for (const r of candidateReps) {
    if (r + 1 >= incidentOffsets.length) continue;
    const start = incidentOffsets[r];
    const end = incidentOffsets[r + 1];
    for (let i = start; i < end; i++) {
      const entry = incidentEntries[i];
      if (seenEntry.has(entry)) continue;
      seenEntry.add(entry);
      const su = edgeSrcLeaf[entry];
      const sv = edgeDstLeaf[entry];
      // BEFORE: representatives under the current cut (parent stands in for nodes under it).
      const bu = selectedRepOf(cols, selected, su);
      const bv = selectedRepOf(cols, selected, sv);
      // AFTER: a parent-side endpoint moves from `parent` to its direct child; the other side
      // (external, or the other direct child) keeps its current representative.
      const au = bu === parent ? childUnderParent(su) : bu;
      const av = bv === parent ? childUnderParent(sv) : bv;
      addPairKey(before, bu, bv);
      addPairKey(after, au, av);
    }
  }
  return after.size - before.size;
}

/** Add the canonical unordered (min,max) rep-pair key to `set`, skipping unrepresented/self pairs. */
function addPairKey(set: Set<number>, ra: number, rb: number): void {
  if (ra === -1 || rb === -1 || ra === rb) return;
  const lo = ra < rb ? ra : rb;
  const hi = ra < rb ? rb : ra;
  // Rep ids are < 2^26 at kernel scale, so a 26-bit shift packs the pair collision-free.
  set.add(lo * 0x4000000 + hi);
}

/**
 * The total visible QUOTIENT-graph edge count of the current `selected` antichain (design B2).
 * Used to seed the running edge cost (and to re-seed it after a forceClosed/forceOpen pass moves
 * the selection arbitrarily). A quotient edge exists between two selected reps when some original
 * edge's two endpoints are represented by two DISTINCT selected reps under the cut.
 *
 * Resolved from each indexed edge's two ENDPOINT LEAF reps ({@link RepresentationEdgeIndex.edgeSrcLeaf}/
 * {@link RepresentationEdgeIndex.edgeDstLeaf}) — NOT the stored {@link RepresentationEdgeIndex.pairReps},
 * which sit at the lowest-relevant-pair TIER. The earlier pairReps-based count walked those tier
 * reps UPWARD and so SILENTLY UNDERCOUNTED every cut finer than the pair tier (e.g. a clique under
 * intermediate tiers: the pair reps are intermediate proxies, never selected once the cut reaches
 * leaves, so they resolved to -1 and were dropped). Walking from the LEAF endpoints is correct for
 * ANY cut. O(indexedEdges · depth) — bounded by the indexed (post-filter) edges, not the raw graph;
 * for the bootstrap (single super-root) cut this is 0.
 */
function quotientEdgeCount(
  index: RepresentationEdgeIndex,
  cols: RepresentationColumns,
  selected: ReadonlySet<number>,
): number {
  const seen = new Set<number>();
  const { edgeSrcLeaf, edgeDstLeaf } = index;
  const m = edgeSrcLeaf.length;
  let count = 0;
  for (let i = 0; i < m; i++) {
    const ra = selectedRepOf(cols, selected, edgeSrcLeaf[i]);
    const rb = selectedRepOf(cols, selected, edgeDstLeaf[i]);
    if (ra === -1 || rb === -1 || ra === rb) continue; // unrepresented, or folded into one rep
    const lo = ra < rb ? ra : rb;
    const hi = ra < rb ? rb : ra;
    const key = lo * 0x4000000 + hi;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

/** The selected ancestor-or-self of `rep` (the rep that represents it under the cut), or -1. */
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
