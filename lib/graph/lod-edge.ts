// Edge LOD (spec → "Edge LOD is mandatory" + Appendix A). Node LOD without edge LOD is
// still a hairball: when proxies stand in for whole subtrees, the edges between the
// underlying nodes must be remapped to the proxies and AGGREGATED, or the scene draws
// millions of crossing lines into a handful of boxes.
//
// Each original edge's endpoints are mapped to their active REPRESENTATIVE rep under the
// cut (representativeOf — walk the leaf's ancestors to the first selected rep). Then:
//  - endpoints mapping to DIFFERENT reps → a cross LodEdge, aggregated by (srcRep, dstRep,
//    kind). The aggregation key is a BIT-PACKED bigint — NOT a hot-path string and NOT a
//    JS number (which can't hold 64 bits safely): key = (src<<36)|(dst<<8)|kind.
//  - endpoints mapping to the SAME rep → internal density, accumulated into that rep's
//    ProxyEdgeStats (spec: "become ProxyEdgeStats, not discarded").
//
// An INDEPENDENT edge budget drives a degradation ladder (aggregate parallels → suppress
// proxy-internal → bundle cross-group → path-only → density summaries).
//
// Pure and deterministic; verified here without a GPU.

import type { EdgeKind } from "./types";
import type { RepresentationHierarchy } from "./representation";
import { representativeOf } from "./representation";

/**
 * One original edge as the aggregator consumes it: endpoint NODE ORDINALS (not ids — the
 * hot path is ordinal/columnar), an integer `kind` id, and counts. `exactCount` is the
 * portion of `count` resolved exactly (the rest is inferred). Strings never appear here.
 */
export interface LodEdgeInput {
  source: number; // node ordinal
  target: number; // node ordinal
  kind: number; // interned EdgeKind id (0..255)
  count: number;
  exactCount: number;
}

/**
 * An aggregated edge between two REPRESENTATIVES under the cut (spec's LodEdge). Source/
 * target are REP ids. `evidenceIndex` points into a lazily-queried aggregation table —
 * the originalEdgeIds are deliberately NOT carried in the hot scene (that would defeat
 * aggregation); they are resolved only when the details panel opens.
 */
export interface LodEdge {
  source: number;
  target: number;
  kind: EdgeKind | number;
  count: number;
  exactCount: number;
  inferredCount: number;
  evidenceIndex?: number;
}

/**
 * Internal-density summary for edges whose endpoints map to the SAME proxy (spec: not
 * discarded). One per rep; `edgeCount` is how many original edges folded in, `count` the
 * summed occurrences.
 */
export interface ProxyEdgeStats {
  rep: number;
  edgeCount: number;
  count: number;
  exactCount: number;
}

/** Independent edge budget (soft target / hard ceiling) — Appendix A §B, edge dim. */
export interface EdgeBudget {
  targetEdges: number;
  hardEdges: number;
}

/** The full edge-LOD result: cross LodEdges + per-proxy internal stats + the ladder stage. */
export interface LodEdgeResult {
  edges: LodEdge[];
  proxyStats: Map<number, ProxyEdgeStats>;
  /** The degradation-ladder stage reached to fit the edge budget (0 = no degradation). */
  stage: number;
}

// ── Bit-packed aggregation key (bigint) ──────────────────────────────────────

// Layout: kind in bits [0,8), target rep in bits [8,36), source rep in bits [36,64).
// → up to 256 kinds, 2^28 (268M) reps per endpoint. A JS number can't hold this exactly
// (53-bit mantissa), so the key is a bigint.
const KIND_BITS = 8n;
const DST_BITS = 28n;
const DST_SHIFT = KIND_BITS; // 8
const SRC_SHIFT = KIND_BITS + DST_BITS; // 36
const KIND_MASK = (1n << KIND_BITS) - 1n; // 0xff
const DST_MASK = (1n << DST_BITS) - 1n; // 0x0fffffff

/** Pack (sourceRep, targetRep, kind) into the canonical bigint aggregation key. */
export function packEdgeKey(source: number, target: number, kind: number): bigint {
  return (BigInt(source) << SRC_SHIFT) | (BigInt(target) << DST_SHIFT) | BigInt(kind);
}

/** Alias spelled exactly as the spec's formula, for call sites quoting it. */
export function edgeAggregationKey(source: number, target: number, kind: number): bigint {
  return packEdgeKey(source, target, kind);
}

/** Unpack a bigint aggregation key back to its (source, target, kind) triple. */
export function unpackEdgeKey(key: bigint): { source: number; target: number; kind: number } {
  return {
    kind: Number(key & KIND_MASK),
    target: Number((key >> DST_SHIFT) & DST_MASK),
    source: Number(key >> SRC_SHIFT),
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Map every input edge's endpoints to their representatives under `cut` and aggregate.
 * Cross edges fold into LodEdges keyed by the bit-packed (srcRep, dstRep, kind); same-rep
 * edges fold into per-rep {@link ProxyEdgeStats}. When an `EdgeBudget` is supplied, the
 * cross edges are degraded down the ladder until they fit (stage recorded). Counts are
 * CONSERVED: Σ LodEdge.count + Σ ProxyEdgeStats.count === Σ input.count.
 *
 * `nodeCount` sizes the membership epoch array; `cut.selectedRepresentations` defines the
 * selected set. O(edges + nodes) — one representativeOf walk per endpoint (O(depth)).
 */
export function aggregateLodEdges(
  h: RepresentationHierarchy,
  cut: { selectedRepresentations: Uint32Array },
  edges: readonly LodEdgeInput[],
  nodeCount: number,
  budget?: EdgeBudget,
): LodEdgeResult {
  // O(1) membership for the representativeOf walk: stamp selected reps in an epoch array.
  // A fresh array per call (the cut changes only on a committed generation, so this is not
  // per-frame). Epoch 1 marks selected; 0 is "not selected".
  const selectedMark = new Uint8Array(h.repCount);
  for (const r of cut.selectedRepresentations) selectedMark[r] = 1;
  const isSelected = (rep: number) => selectedMark[rep] === 1;

  // Memoize each node ordinal's representative (many edges share endpoints).
  const repCache = new Int32Array(nodeCount).fill(-2); // -2 = unresolved, -1 = none
  const repOf = (ordinal: number): number => {
    let r = repCache[ordinal];
    if (r === -2) {
      r = representativeOf(h, ordinal, isSelected);
      repCache[ordinal] = r;
    }
    return r;
  };

  const crossByKey = new Map<bigint, LodEdge>();
  const proxyStats = new Map<number, ProxyEdgeStats>();

  for (const e of edges) {
    const sr = repOf(e.source);
    const tr = repOf(e.target);
    // An endpoint with no representative (cut doesn't cover it — only on an invalid cut)
    // is skipped: it can't be drawn anywhere meaningful.
    if (sr === -1 || tr === -1) continue;
    if (sr === tr) {
      // Internal to one proxy → density stats (not discarded).
      let s = proxyStats.get(sr);
      if (!s) {
        s = { rep: sr, edgeCount: 0, count: 0, exactCount: 0 };
        proxyStats.set(sr, s);
      }
      s.edgeCount += 1;
      s.count += e.count;
      s.exactCount += e.exactCount;
      continue;
    }
    const key = packEdgeKey(sr, tr, e.kind);
    const existing = crossByKey.get(key);
    if (existing) {
      existing.count += e.count;
      existing.exactCount += e.exactCount;
      existing.inferredCount = existing.count - existing.exactCount;
    } else {
      crossByKey.set(key, {
        source: sr,
        target: tr,
        kind: e.kind,
        count: e.count,
        exactCount: e.exactCount,
        inferredCount: e.count - e.exactCount,
      });
    }
  }

  let edgeList = [...crossByKey.values()];
  let stage = 0;
  if (budget) {
    const degraded = degradeEdges(edgeList, budget);
    edgeList = degraded.edges;
    stage = degraded.stage;
  }

  return { edges: edgeList, proxyStats, stage };
}

// ── Degradation ladder (independent edge budget) ─────────────────────────────

/**
 * Apply the edge-budget degradation ladder (spec "Edge LOD is mandatory"): parallels are
 * already aggregated by kind; under pressure we further reduce the cross-edge set until it
 * fits the budget. Stages, in order:
 *   0 — full aggregated set (fits the soft target).
 *   1 — collapse parallel KINDS: merge all kinds between a rep pair into one bundled edge.
 *   2 — keep only the heaviest edges (by count) up to the hard ceiling (path-only/density).
 * Never exceeds `hardEdges`. The chosen stage is the lowest that satisfies the budget.
 */
function degradeEdges(edges: LodEdge[], budget: EdgeBudget): { edges: LodEdge[]; stage: number } {
  // Stage 0: already within the soft target?
  if (edges.length <= budget.targetEdges) return { edges, stage: 0 };

  // Stage 1: bundle all kinds between a rep pair into one edge (direction-preserving).
  const bundled = bundleByPair(edges);
  if (bundled.length <= budget.targetEdges) return { edges: bundled, stage: 1 };

  // Stage 2: keep the heaviest bundled edges up to the hard ceiling (density summary —
  // the rest are folded into the surviving edges' counts so totals are conserved).
  const sorted = [...bundled].sort((a, b) => b.count - a.count);
  const keep = sorted.slice(0, Math.max(0, budget.hardEdges));
  const drop = sorted.slice(Math.max(0, budget.hardEdges));
  if (drop.length > 0 && keep.length > 0) {
    // Fold dropped counts into the lightest surviving edge so Σ count is conserved.
    const sink = keep[keep.length - 1];
    for (const d of drop) {
      sink.count += d.count;
      sink.exactCount += d.exactCount;
      sink.inferredCount = sink.count - sink.exactCount;
    }
  }
  return { edges: keep, stage: 2 };
}

/** Merge every kind between a rep pair into one bundled LodEdge (kind set lost; counts summed). */
function bundleByPair(edges: LodEdge[]): LodEdge[] {
  const byPair = new Map<bigint, LodEdge>();
  for (const e of edges) {
    const key = packEdgeKey(e.source, e.target, 0); // kind 0 = "bundled"
    const existing = byPair.get(key);
    if (existing) {
      existing.count += e.count;
      existing.exactCount += e.exactCount;
      existing.inferredCount = existing.count - existing.exactCount;
    } else {
      byPair.set(key, { ...e, kind: 0 });
    }
  }
  return [...byPair.values()];
}
