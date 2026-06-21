// LOD observability (Appendix A §I) — derive the dev-overlay stats from a committed
// representation cut. The spec mandates this "from day one of C1b": tuning the
// projectedError priority blindly is otherwise hopeless. Pure: it reads a RepLodResult
// (+ optional timings) and the budget and produces a flat, JSON-friendly stats object the
// overlay renders. No React here.

import type { LimitedDetail, LodBudget, WhyNotRefined } from "./lod-cut-solver";
import type { RepresentationHierarchy } from "./representation";
import type { RepLodResult } from "./lod-representation-cut";
import type { MaterializeCounter } from "./proxy-materialize";

/** One row of the per-rep why-not-refined breakdown (aggregated by reason). */
export interface WhyNotRefinedRow {
  reason: WhyNotRefined;
  count: number;
}

/** The flat overlay stats (Appendix A §I checklist). */
export interface RepLodOverlayStats {
  /** LOD committed generation. */
  generation: number;
  /** Whether this solve committed a new generation. */
  committed: boolean;
  /** Selected reps in the committed cut (the "committed reps"). */
  committedReps: number;
  /** Selected reps in the pending cut (may differ before a commit). */
  pendingReps: number;
  /** Rendered card / edge / label cost of the committed cut. */
  cards: number;
  edges: number;
  labels: number;
  /** Soft targets (auto ceiling) for the same dims. */
  targetCards: number;
  targetEdges: number;
  targetLabels: number;
  /** Hard ceilings. */
  hardCards: number;
  /** GPU megabytes of the committed cut. */
  gpuMB: number;
  /** Layout-work percent of the hard layout budget (0..1, clamped). */
  layoutWorkPct: number;
  /** Atomic refinements committed this solve. */
  refinements: number;
  /** Auto-open evictions this commit (offscreen-over-budget). */
  evictions: number;
  /** Proxy-cache hit rate this commit (0..1). */
  proxyCacheHitRate: number;
  /** Cut-solve milliseconds. */
  cutSolveMs: number;
  /** Scene-rebuild milliseconds (the downstream rebuild this committed generation drove). */
  sceneRebuildMs: number;
  /** Per-rep why-not-refined, aggregated by reason (descending count). */
  whyNotRefined: WhyNotRefinedRow[];
}

/** Optional timings + counters the canvas measures around a committed cut. */
export interface RepLodTimings {
  cutSolveMs?: number;
  sceneRebuildMs?: number;
  evictions?: number;
  proxyCacheHits?: number;
  proxyCacheMisses?: number;
  /** The budget used for the solve (for the vs-budget readouts). */
  budget?: LodBudget;
  /** The solver's diagnostics (why-not-refined + refinements), if collected. */
  whyNotRefined?: Map<number, WhyNotRefined>;
  refinements?: number;
}

/** Count selected reps in a cut. */
function repCountOf(cut: { selectedRepresentations: Uint32Array }): number {
  return cut.selectedRepresentations.length;
}

/** Aggregate a per-rep why-not-refined map into reason rows, descending by count. */
function aggregateWhyNot(map: Map<number, WhyNotRefined> | undefined): WhyNotRefinedRow[] {
  if (!map) return [];
  const counts = new Map<WhyNotRefined, number>();
  for (const reason of map.values()) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build the overlay stats from a committed representation result. `timings` carries the
 * measured wall-clock + cache counters (the pure cut can't time itself). Sums the
 * committed cut's GPU/layout cost from the hierarchy columns.
 */
export function summarizeRepLod(
  result: RepLodResult,
  timings: RepLodTimings = {},
): RepLodOverlayStats {
  const { runtime, hierarchy, cut } = result;
  const budget = timings.budget;
  const gpuBytes = sumGpu(hierarchy, cut.selectedRepresentations);
  const layoutWork = cut.layoutCost; // Σ (1 + symbols) over selected reps — distinct from cards
  const hardLayout = budget?.hardLayoutCost ?? Infinity;
  const layoutWorkPct = Number.isFinite(hardLayout) && hardLayout > 0 ? layoutWork / hardLayout : 0;
  const hits = timings.proxyCacheHits ?? 0;
  const misses = timings.proxyCacheMisses ?? 0;
  const hitRate = hits + misses > 0 ? hits / (hits + misses) : 0;

  return {
    generation: runtime.generation,
    committed: result.committed,
    committedReps: repCountOf(runtime.committedCut),
    pendingReps: repCountOf(runtime.pendingCut),
    cards: cut.cardCost,
    edges: cut.edgeCost,
    labels: cut.labelCost,
    targetCards: budget?.targetCards ?? 0,
    targetEdges: budget?.targetEdges ?? 0,
    targetLabels: budget?.targetLabels ?? 0,
    hardCards: budget?.hardCards ?? 0,
    gpuMB: gpuBytes / (1024 * 1024),
    layoutWorkPct: Math.max(0, Math.min(1, layoutWorkPct)),
    // Prefer explicit timings, else the real counters the cut now carries (Phase C1c bug b:
    // the eviction count is a genuine number from the controller, no longer hardcoded 0).
    refinements: timings.refinements ?? result.diagnostics?.refinements ?? 0,
    evictions: timings.evictions ?? result.evictions,
    proxyCacheHitRate: hitRate,
    cutSolveMs: timings.cutSolveMs ?? result.cutSolveMs,
    sceneRebuildMs: timings.sceneRebuildMs ?? 0,
    whyNotRefined: aggregateWhyNot(timings.whyNotRefined),
  };
}

/** Sum the GPU byte cost of the selected reps. */
function sumGpu(h: RepresentationHierarchy, reps: Uint32Array): number {
  let total = 0;
  for (const r of reps) total += h.columns.gpuByteCost[r];
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// P4 STRESS METRICS (spec "Revised implementation order" → P4 "New stress metrics")
//
// The overlay stats above answer "what does the committed cut look like NOW". The stress
// metrics answer "is the architecture holding its scale guarantees" — the eight readouts P4
// names, each tied to a specific invariant the spec demands and the cutover gate asserts:
//
//   1. original NODES scanned per recut          — Gap 9: a single-group refine is LOCAL.
//   2. original EDGES scanned per recut           — Gap 9: via the edge index, not all edges.
//   3. max representation FAN-OUT                 — B1 invariant (b): ≤ MAX_FANOUT.
//   4. BOOTSTRAP-cut cards vs hardCards            — B1 invariant (a): coarsest cut is feasible.
//   5. REJECTED explicit opens by budget category — forced-open arbitration: LimitedDetail.
//   6. time from CAMERA MOVE to committed refinement — P3 perf objective (cached < 16 ms).
//   7. STALE local-layout jobs discarded          — B3 rule 6: a result whose gen ≠ live drops.
//   8. PEAK local-layout cache MEMORY              — P3 "cache memory limit / LRU".
//
// This is pure + JSON-friendly: it reads a committed result + the counters the orchestration
// layers already keep (the materializer's MaterializeCounter, the ReadinessController's stale
// count, the BoundedLayoutCache's peak byteSize) and folds them into one flat report. It runs
// no solve, no layout, no scene mutation — the caller measures, this aggregates + judges.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Which finite hard ceiling stopped a rejected explicit open (LimitedDetail.limitingBudget). */
export type LimitingBudget = LimitedDetail["limitingBudget"];

/** Rejected explicit opens grouped by the budget category that stopped each (metric 5). */
export interface RejectedOpensByCategory {
  cards: number;
  edges: number;
  labels: number;
  gpu: number;
  layout: number;
  /** Total rejected opens (== sum of the five categories). */
  total: number;
}

/** The eight P4 stress metrics + the invariant verdicts the cutover gate turns on. */
export interface RepLodStressMetrics {
  // ── metric 1 + 2 — original nodes / edges scanned on the measured single-group recut ──
  nodesScannedPerRecut: number;
  edgesScannedPerRecut: number;
  /** The full graph sizes the per-recut scans must stay below (the bound, not a scan). */
  totalNodes: number;
  totalEdges: number;
  // ── metric 3 — the widest fan-out of any rep in the persistent hierarchy ──
  maxFanout: number;
  // ── metric 4 — the coarsest (bootstrap) cut's card cost vs the finite hard ceiling ──
  bootstrapCards: number;
  hardCards: number;
  /** bootstrapCards / hardCards (0..1 when feasible) — the "how much headroom" readout. */
  bootstrapCutRatio: number;
  // ── metric 5 — rejected explicit opens, by the budget category that limited each ──
  rejectedOpensByCategory: RejectedOpensByCategory;
  // ── metric 6 — wall-clock from the camera move to the committed refinement (ms) ──
  cameraToCommitMs: number;
  // ── metric 7 — async local-layout results discarded as stale (gen ≠ live) ──
  staleLayoutJobsDiscarded: number;
  // ── metric 8 — peak local-layout cache footprint (bytes) over the session ──
  peakLayoutCacheBytes: number;

  // ── invariants (the asserted contract — each is a pure consequence of the readouts) ──
  /** A single-group refine scans work bounded by the changed subtree, NOT the whole graph. */
  refineBoundedBySubtree: boolean;
  /** No rep exceeds MAX_FANOUT children (B1 invariant b). */
  fanoutWithinBound: boolean;
  /** The bootstrap (coarsest) cut fits the hard card ceiling (B1 invariant a). */
  bootstrapFeasible: boolean;
}

/**
 * The counters the orchestration layers accumulate over a session, fed into the stress report.
 * Each is owned by an existing P3 layer — this is purely the read side:
 *   - `materializeCounter`  — the {@link MaterializeCounter} the IncrementalMaterializer wrote on
 *     the MEASURED single-group recut (the local nodes/edges it touched). Metrics 1 + 2.
 *   - `cameraToCommitMs`    — wall-clock the caller timed from the camera move to the atomic
 *     commit of the refinement (P3 perf objective). Metric 6.
 *   - `staleLayoutJobsDiscarded` — count of async results the {@link ReadinessController} judged
 *     "stale-generation" (B3 rule 6). Metric 7.
 *   - `peakLayoutCacheBytes` — the high-water mark of the {@link BoundedLayoutCache}'s `byteSize`
 *     observed over the session (sample after each `set`). Metric 8.
 */
export interface StressCounters {
  materializeCounter?: MaterializeCounter;
  cameraToCommitMs?: number;
  staleLayoutJobsDiscarded?: number;
  peakLayoutCacheBytes?: number;
  /**
   * The ORIGINAL edge population the materializer scans from (the real per-node-ordinal edge
   * list), against which `edgesScanned` is bounded. The caller knows this exactly; the edge
   * INDEX's CSR boundary-entry count is NOT it (the index aggregates + dedups cross-boundary
   * edges, so it is strictly smaller than the original edge set the materializer walks). When
   * omitted, falls back to the CSR boundary-entry count — only safe when no edges were scanned.
   */
  totalOriginalEdges?: number;
}

/** Count fan-out (children) of a rep without materializing a child list. */
function fanoutOf(h: RepresentationHierarchy, rep: number): number {
  const { firstChildByRep, nextSiblingByRep } = h.columns;
  let n = 0;
  let c = firstChildByRep[rep];
  let guard = h.repCount + 1;
  while (c !== -1 && guard-- > 0) {
    n++;
    c = nextSiblingByRep[c];
  }
  return n;
}

/** The widest fan-out across every rep in the hierarchy (metric 3 / invariant b). */
export function maxRepresentationFanout(h: RepresentationHierarchy): number {
  let max = 0;
  for (let rep = 0; rep < h.repCount; rep++) {
    const n = fanoutOf(h, rep);
    if (n > max) max = n;
  }
  return max;
}

/** Group a solve's "Detail limited" rejections by the budget category that stopped each (metric 5). */
export function rejectedOpensByCategory(
  limited: readonly LimitedDetail[],
): RejectedOpensByCategory {
  const out: RejectedOpensByCategory = {
    cards: 0,
    edges: 0,
    labels: 0,
    gpu: 0,
    layout: 0,
    total: 0,
  };
  for (const l of limited) {
    out[l.limitingBudget]++;
    out.total++;
  }
  return out;
}

/**
 * Fold a committed representation result + the session counters into the eight P4 stress
 * metrics and their invariant verdicts (spec P4 "New stress metrics"). `maxFanout` is read
 * straight from the persistent hierarchy; `bootstrapCards`/`hardCards` from the budget; the
 * rejected-opens histogram from `result.limitedDetails`; the remaining four readouts from the
 * caller-supplied {@link StressCounters} (the orchestration layers' own counters). Pure +
 * deterministic; asserts nothing itself — it exposes the invariant booleans the gate checks.
 *
 * `maxFanoutBound` is the constant the fan-out must respect (MAX_FANOUT); the caller passes it
 * so this module need not import the representation constant (and the bench/test can vary it).
 * `bootstrapCards` is the coarsest (bootstrap) cut's card cost — the caller computes it once
 * with `bootstrapCut(hierarchy).cardCost`; passing it keeps this module from re-running the
 * solver just to measure the denominator of invariant (a).
 */
export function collectStressMetrics(
  result: RepLodResult,
  maxFanoutBound: number,
  bootstrapCards: number,
  counters: StressCounters = {},
): RepLodStressMetrics {
  const { repRuntime, hierarchy, budget, limitedDetails } = result;
  const mc = counters.materializeCounter;
  const nodesScannedPerRecut = mc?.nodesScanned ?? 0;
  const edgesScannedPerRecut = mc?.edgesScanned ?? 0;
  // The full-graph sizes the per-recut scans must stay below — the leaf-node count (one leaf
  // rep per visible node) and the ORIGINAL edge population. The caller supplies the true edge
  // total (it owns the edge list the materializer walks); we fall back to the CSR boundary-entry
  // count only when no edge total is given (and no edges were scanned, so the bound is trivial).
  const totalNodes = hierarchy.columns.leafRepresentationByNode.length;
  const totalEdges =
    counters.totalOriginalEdges ??
    repRuntime.edgeIndex?.outgoingTargets.length ??
    edgesScannedPerRecut;

  const maxFanout = maxRepresentationFanout(hierarchy);
  const hardCards = budget.hardCards;

  return {
    nodesScannedPerRecut,
    edgesScannedPerRecut,
    totalNodes,
    totalEdges,
    maxFanout,
    bootstrapCards,
    hardCards,
    bootstrapCutRatio: hardCards > 0 ? bootstrapCards / hardCards : 0,
    rejectedOpensByCategory: rejectedOpensByCategory(limitedDetails),
    cameraToCommitMs: counters.cameraToCommitMs ?? 0,
    staleLayoutJobsDiscarded: counters.staleLayoutJobsDiscarded ?? 0,
    peakLayoutCacheBytes: counters.peakLayoutCacheBytes ?? 0,
    // ── invariants ──
    // A single-group refine is bounded by its subtree iff it scanned STRICTLY fewer original
    // nodes than the whole graph (the rest of the graph was never visited) AND no more edges
    // than the indexed population. When no recut was measured (counter absent) the invariant
    // is vacuously held (0 < totalNodes for any non-empty graph).
    refineBoundedBySubtree:
      mc === undefined
        ? true
        : nodesScannedPerRecut < totalNodes && edgesScannedPerRecut <= totalEdges,
    fanoutWithinBound: maxFanout <= maxFanoutBound,
    bootstrapFeasible: bootstrapCards <= hardCards,
  };
}
