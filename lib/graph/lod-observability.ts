// LOD observability (Appendix A §I) — derive the dev-overlay stats from a committed
// representation cut. The spec mandates this "from day one of C1b": tuning the
// projectedError priority blindly is otherwise hopeless. Pure: it reads a RepLodResult
// (+ optional timings) and the budget and produces a flat, JSON-friendly stats object the
// overlay renders. No React here.

import type { LodBudget, WhyNotRefined } from "./lod-cut-solver";
import type { RepresentationHierarchy } from "./representation";
import type { RepLodResult } from "./lod-representation-cut";

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
