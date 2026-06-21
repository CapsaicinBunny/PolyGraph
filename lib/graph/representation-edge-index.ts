// RepresentationEdgeIndex — a persistent, cut-aware hierarchical edge index built
// alongside the representation hierarchy (design B2 + impl note (a)).
//
// WHY this exists (design B2): edge cost is cut-DEPENDENT, not additive. The number of
// visible aggregated edges depends on WHICH proxies are co-selected — two children of the
// same parent may share one aggregated edge at the parent level but become two distinct
// edges once both are open; an edge between two folded subtrees collapses to a single
// boundary edge. So the solver's edge gate (the marginal Δedges of a parent→children
// refinement) needs to evaluate the quotient graph LOCALLY, without scanning all ~1.3M
// edges per recut. This index provides:
//
//   (1) BOUNDARY SUMMARIES per rep — the aggregated cross-boundary edge endpoints toward
//       OTHER reps. For every rep R, `outgoing*` lists the sibling-level boundaries on R's
//       OUT side (the child of R's parent that R's out-edges land on) and `incoming*` the
//       IN side, each de-duplicated and counted. Refining a proxy into its children is
//       priced by reading the children's boundary summaries — local to the refined region.
//
//   (2) ORIGINAL EDGE RANGES grouped by the LOWEST RELEVANT REP PAIR — the two DIRECT
//       CHILDREN of the lowest common ancestor (LCA) rep an edge crosses (the deepest
//       boundary at which the edge's endpoints diverge). `rangeOffsets` + `originalEdge
//       Ordinals` is a CSR over those pairs, so the real edges under any proxy↔proxy
//       boundary at ONE tier are retrieved by a range lookup, never by scanning all edges
//       (design B2 "without scanning all edges"; Gap 9 incremental materialization).
//
// COLUMNAR / CSR LAYOUT (impl note (a)): NOT a Uint32Array[] per rep — at kernel scale that
// is millions of small objects (fragmented heap, poor locality, expensive worker transfer).
// Everything is flat typed-array columns indexed by CSR offsets. All Uint32Array except
// `outgoingKinds` (Uint16Array — interned EdgeKind id, 0..65535).
//
// POST-FILTER: built from the post-filter graph. An edge with a HIDDEN endpoint (per the
// hierarchy's detachment — a leaf rep parented to DETACHED_REP) is dropped, exactly as the
// builder drops hidden leaves, so the index never references a rep outside the rendered cut.
//
// Cached on the SAME material signature as the P0 persistent RepresentationRuntime (the
// hierarchy it indexes is a pure function of that signature, and the post-filter edge set is
// part of the filtered-graph identity folded into it). Pure; deterministic; no React, no GPU.

import { DETACHED_REP, type RepresentationHierarchy } from "./representation";

/**
 * Version of the edge-index BUILDER. Folded into the runtime material signature so a change to
 * the index layout / pairing rule invalidates every cached index. It is a STANDALONE literal
 * (not concatenated with {@link representationBuilderVersion}): the material signature folds the
 * hierarchy builder version in SEPARATELY (`b=…|e=…`), and the index is rebuilt together with
 * the hierarchy whenever EITHER changes, so duplicating it here would be redundant — and a
 * concatenation at module-init order would create a circular-import initialization hazard (the
 * builder version lives in representation.ts, which re-exports this module). Bump on ANY change
 * to the columns or the pairing rule.
 */
export const representationEdgeIndexVersion = "rei1";

/**
 * The post-filter edges to index, by node ORDINAL (parallel to the hierarchy's node order).
 * Direction matters for the boundary summaries (outgoing vs incoming); `kind` is an interned
 * EdgeKind id (0..65535, stored Uint16). `weight` is the aggregated occurrence count of the
 * edge (defaults to 1) — summed into the boundary `*Counts`. Self-loops and edges with a
 * hidden / out-of-range endpoint are ignored.
 */
export interface EdgeIndexInput {
  source: number; // node ordinal
  target: number; // node ordinal
  kind: number; // interned EdgeKind id (0..65535)
  weight?: number;
}

/**
 * The compact columnar (CSR) edge index (design B2 + impl note (a)). Every array is indexed
 * via CSR offsets; nothing is per-rep allocated.
 *
 * ── Boundary summaries (the cut-aware quotient-edge source) ──
 * For a rep R, its OUTGOING boundary entries are the DISTINCT sibling reps that R's out-edges
 * cross to at R's OWN tier — i.e. for each indexed edge (u→v) whose lowest relevant rep pair
 * is (a, b) with `a` an ancestor-or-self chain through R, the child of R's parent on the v
 * side. Concretely we record, per rep R, the set of reps B such that some original edge leaves
 * R's subtree and enters B's subtree where R and B are SIBLINGS (children of a common parent).
 * `outgoingTargets[outgoingOffsets[R] .. outgoingOffsets[R+1])` are those sibling reps B;
 * `outgoingKinds` the per-entry interned kind; `outgoingCounts` the summed weight. The
 * incoming side is symmetric (`incomingSources`). Entries are sorted (by target/source rep,
 * then kind) and de-duplicated per (R, otherRep, kind), so reading a rep's slice gives the
 * aggregated cross-boundary edges at that rep's tier in O(degree-at-tier), never O(all edges).
 *
 * ── Original edge ranges by lowest relevant rep pair ──
 * `rangeOffsets` + `originalEdgeOrdinals` is a CSR over the DISTINCT lowest-relevant rep pairs
 * (sorted ascending by (minRep, maxRep)); `pairReps[2k], pairReps[2k+1]` are the two reps of
 * pair k (always minRep ≤ maxRep — the boundary is undirected for retrieval). The original
 * edge ordinals (indices into the input array) crossing exactly that pair's boundary live in
 * `originalEdgeOrdinals[rangeOffsets[k] .. rangeOffsets[k+1])`. {@link edgesBetween} resolves
 * a (repA, repB) sibling boundary to its range without scanning all edges (Gap 9).
 */
export interface RepresentationEdgeIndex {
  // ── boundary summaries — OUT side (CSR by rep id) ────────────────────────────
  /** length repCount+1; `outgoingOffsets[r]..outgoingOffsets[r+1]` slices the OUT columns. */
  outgoingOffsets: Uint32Array;
  /** the sibling rep each OUT boundary entry crosses to. */
  outgoingTargets: Uint32Array;
  /** interned EdgeKind id of each OUT boundary entry (0..65535). */
  outgoingKinds: Uint16Array;
  /** summed weight (occurrence count) of each OUT boundary entry. */
  outgoingCounts: Uint32Array;
  // ── boundary summaries — IN side (CSR by rep id) ─────────────────────────────
  /** length repCount+1; `incomingOffsets[r]..incomingOffsets[r+1]` slices the IN columns. */
  incomingOffsets: Uint32Array;
  /** the sibling rep each IN boundary entry crosses from. */
  incomingSources: Uint32Array;
  /** summed weight of each IN boundary entry (kinds mirror the OUT side; omitted to stay compact). */
  incomingCounts: Uint32Array;
  // ── original edge ranges by lowest relevant rep pair (CSR by pair index) ──────
  /** length pairCount+1; `rangeOffsets[k]..rangeOffsets[k+1]` slices `originalEdgeOrdinals`. */
  rangeOffsets: Uint32Array;
  /** the two reps of pair k: `pairReps[2k]` = minRep, `pairReps[2k+1]` = maxRep. */
  pairReps: Uint32Array;
  /** original edge ordinals (indices into the input) grouped by lowest relevant rep pair. */
  originalEdgeOrdinals: Uint32Array;
  /** rep count the boundary CSR is sized to (== hierarchy.repCount). */
  repCount: number;
  /** distinct lowest-relevant rep pairs (== rangeOffsets.length - 1). */
  pairCount: number;
}

/**
 * Build the persistent CSR edge index for a hierarchy from the post-filter edges (design B2
 * + impl note (a)). For each input edge it:
 *
 *  1. resolves the two endpoint LEAF reps (drops the edge if either endpoint is hidden /
 *     detached or the endpoints share a leaf — a self loop after mapping);
 *  2. finds the LOWEST RELEVANT REP PAIR (a, b): the two DISTINCT direct children of the
 *     endpoints' LCA rep — the deepest boundary the edge crosses — via the hierarchy's O(1)
 *     DFS-interval ancestor test plus a parent walk;
 *  3. accumulates the original-edge ordinal under that pair's range, and the (a→b)/(b→a)
 *     directed boundary entries into the OUT/IN summaries.
 *
 * Then it materializes the three CSRs (boundary OUT, boundary IN, ranges by pair) as flat
 * columns. O(E · depth) build, O(E + reps) memory; deterministic (pairs and entries sorted).
 */
export function buildRepresentationEdgeIndex(
  hierarchy: RepresentationHierarchy,
  edges: readonly EdgeIndexInput[],
): RepresentationEdgeIndex {
  const { columns, repCount } = hierarchy;
  const { leafRepresentationByNode, parentByRep, entryByRep, exitByRep } = columns;
  const nodeCount = leafRepresentationByNode.length;

  // A leaf rep is HIDDEN/detached iff it is parented to DETACHED_REP (the post-filter mask).
  const isDetachedLeaf = (rep: number): boolean => parentByRep[rep] === DETACHED_REP;

  // O(1) ancestor test via DFS intervals (a is ancestor-or-self of b).
  const isAncestor = (a: number, b: number): boolean =>
    entryByRep[a] <= entryByRep[b] && exitByRep[b] <= exitByRep[a];

  // The DIRECT CHILD of `parent` that is an ancestor-or-self of `rep`. Walks up from `rep`
  // until its parent IS `parent`. Returns -1 if `parent` is not a proper ancestor of `rep`.
  const childOfUnder = (rep: number, parent: number): number => {
    let cur = rep;
    let guard = repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      const p = parentByRep[cur];
      if (p === parent) return cur;
      cur = p;
    }
    return -1;
  };

  // LCA of two leaf reps: align by walking the deeper one up (no depth array on reps, so we
  // use the DFS-interval ancestor test). Walk `a` up until it is an ancestor-or-self of `b`.
  const lcaRep = (a: number, b: number): number => {
    let cur = a;
    let guard = repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (isAncestor(cur, b)) return cur;
      cur = parentByRep[cur];
    }
    return -1; // disjoint trees (different roots / a detached side) — caller drops the edge
  };

  // Aggregation buffers. Directed boundary entries keyed (fromRep, toRep, kind) → summed
  // weight (OUT side); the IN side is the transpose. Ranges keyed by the sorted pair.
  const outAgg = new Map<string, { from: number; to: number; kind: number; count: number }>();
  const inAgg = new Map<string, { to: number; from: number; count: number }>();
  // sorted "min|max" pair key → the original edge ordinals crossing that boundary.
  const rangeByPair = new Map<string, { min: number; max: number; ordinals: number[] }>();

  const w = (e: EdgeIndexInput) => e.weight ?? 1;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const u = e.source;
    const v = e.target;
    if (u === v) continue;
    if (u < 0 || u >= nodeCount || v < 0 || v >= nodeCount) continue;
    const lu = leafRepresentationByNode[u];
    const lv = leafRepresentationByNode[v];
    if (isDetachedLeaf(lu) || isDetachedLeaf(lv)) continue; // hidden endpoint — post-filter
    if (lu === lv) continue; // same leaf (shouldn't happen for u≠v, but defensive)

    const lca = lcaRep(lu, lv);
    if (lca === -1) continue; // disjoint — no crossing boundary in this forest

    // The two DIRECT CHILDREN of the LCA the edge crosses — the lowest relevant rep pair.
    const a = childOfUnder(lu, lca);
    const b = childOfUnder(lv, lca);
    if (a === -1 || b === -1 || a === b) continue; // degenerate (one endpoint IS the LCA)

    const kind = e.kind & 0xffff;
    const cnt = w(e);

    // OUT entry a→b, IN entry b←a (directed by the original edge u→v).
    const ok = `${a}|${b}|${kind}`;
    const oe = outAgg.get(ok);
    if (oe) oe.count += cnt;
    else outAgg.set(ok, { from: a, to: b, kind, count: cnt });
    const ik = `${b}|${a}|${kind}`;
    const ie = inAgg.get(ik);
    if (ie) ie.count += cnt;
    else inAgg.set(ik, { to: b, from: a, count: cnt });

    // Range: group the ORIGINAL edge ordinal under the sorted (min,max) boundary pair.
    const min = a < b ? a : b;
    const max = a < b ? b : a;
    const rk = `${min}|${max}`;
    const r = rangeByPair.get(rk);
    if (r) r.ordinals.push(i);
    else rangeByPair.set(rk, { min, max, ordinals: [i] });
  }

  // ── Materialize the OUT boundary CSR (sorted by from, then to, then kind) ──────
  const outEntries = [...outAgg.values()].sort(
    (x, y) => x.from - y.from || x.to - y.to || x.kind - y.kind,
  );
  const outgoingOffsets = new Uint32Array(repCount + 1);
  for (const en of outEntries) outgoingOffsets[en.from + 1]++;
  for (let r = 0; r < repCount; r++) outgoingOffsets[r + 1] += outgoingOffsets[r];
  const outgoingTargets = new Uint32Array(outEntries.length);
  const outgoingKinds = new Uint16Array(outEntries.length);
  const outgoingCounts = new Uint32Array(outEntries.length);
  {
    const cursor = outgoingOffsets.slice(0, repCount);
    for (const en of outEntries) {
      const at = cursor[en.from]++;
      outgoingTargets[at] = en.to;
      outgoingKinds[at] = en.kind;
      outgoingCounts[at] = en.count;
    }
  }

  // ── Materialize the IN boundary CSR (sorted by to, then from) ─────────────────
  const inEntries = [...inAgg.values()].sort((x, y) => x.to - y.to || x.from - y.from);
  const incomingOffsets = new Uint32Array(repCount + 1);
  for (const en of inEntries) incomingOffsets[en.to + 1]++;
  for (let r = 0; r < repCount; r++) incomingOffsets[r + 1] += incomingOffsets[r];
  const incomingSources = new Uint32Array(inEntries.length);
  const incomingCounts = new Uint32Array(inEntries.length);
  {
    const cursor = incomingOffsets.slice(0, repCount);
    for (const en of inEntries) {
      const at = cursor[en.to]++;
      incomingSources[at] = en.from;
      incomingCounts[at] = en.count;
    }
  }

  // ── Materialize the range CSR (sorted by min, then max) ───────────────────────
  const pairs = [...rangeByPair.values()].sort((x, y) => x.min - y.min || x.max - y.max);
  const pairCount = pairs.length;
  const rangeOffsets = new Uint32Array(pairCount + 1);
  const pairReps = new Uint32Array(pairCount * 2);
  let total = 0;
  for (let k = 0; k < pairCount; k++) {
    pairReps[2 * k] = pairs[k].min;
    pairReps[2 * k + 1] = pairs[k].max;
    rangeOffsets[k] = total;
    total += pairs[k].ordinals.length;
  }
  rangeOffsets[pairCount] = total;
  const originalEdgeOrdinals = new Uint32Array(total);
  {
    let at = 0;
    for (const p of pairs) {
      // Keep each range in ascending original-ordinal order (deterministic round-trip).
      p.ordinals.sort((x, y) => x - y);
      for (const ord of p.ordinals) originalEdgeOrdinals[at++] = ord;
    }
  }

  return {
    outgoingOffsets,
    outgoingTargets,
    outgoingKinds,
    outgoingCounts,
    incomingOffsets,
    incomingSources,
    incomingCounts,
    rangeOffsets,
    pairReps,
    originalEdgeOrdinals,
    repCount,
    pairCount,
  };
}

/**
 * A rep's OUTGOING boundary summary at its OWN tier (design B2): the distinct sibling reps its
 * out-edges cross to, with the interned kind and summed weight. O(out-degree at tier). Reading
 * a parent's and its children's summaries is how the solver prices a refinement's marginal
 * Δedges locally, without scanning all edges.
 */
export function outgoingBoundary(
  index: RepresentationEdgeIndex,
  rep: number,
): { target: number; kind: number; count: number }[] {
  const out: { target: number; kind: number; count: number }[] = [];
  const start = index.outgoingOffsets[rep];
  const end = index.outgoingOffsets[rep + 1];
  for (let i = start; i < end; i++) {
    out.push({
      target: index.outgoingTargets[i],
      kind: index.outgoingKinds[i],
      count: index.outgoingCounts[i],
    });
  }
  return out;
}

/**
 * A rep's INCOMING boundary summary at its own tier (the transpose of {@link outgoingBoundary}):
 * the distinct sibling reps whose out-edges land on this rep, with the summed weight.
 */
export function incomingBoundary(
  index: RepresentationEdgeIndex,
  rep: number,
): { source: number; count: number }[] {
  const out: { source: number; count: number }[] = [];
  const start = index.incomingOffsets[rep];
  const end = index.incomingOffsets[rep + 1];
  for (let i = start; i < end; i++) {
    out.push({ source: index.incomingSources[i], count: index.incomingCounts[i] });
  }
  return out;
}

/**
 * Binary-search the range CSR for the lowest-relevant-rep pair (min, max). Returns the pair
 * index, or -1 if no original edge crosses exactly that boundary. The pairs are sorted by
 * (min, max), so this is O(log pairCount).
 */
function pairIndexOf(index: RepresentationEdgeIndex, min: number, max: number): number {
  let lo = 0;
  let hi = index.pairCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pmin = index.pairReps[2 * mid];
    const pmax = index.pairReps[2 * mid + 1];
    if (pmin < min || (pmin === min && pmax < max)) lo = mid + 1;
    else if (pmin > min || (pmin === min && pmax > max)) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * The ORIGINAL edge ordinals (indices into the build input) crossing the boundary between two
 * SIBLING reps `repA` and `repB` — the real edges under that proxy↔proxy boundary, retrieved
 * by a range lookup WITHOUT scanning all edges (design B2 / Gap 9). The boundary is undirected
 * (the pair is stored sorted), so the order of the arguments does not matter. Returns an empty
 * array when no edge crosses exactly that pair.
 *
 * NOTE: this resolves the boundary at the tier where `repA`/`repB` are the LOWEST relevant
 * pair — i.e. they are siblings whose LCA is their common parent. For a coarser boundary (two
 * reps higher in the tree) callers union the ranges of the descendant sibling pairs; that
 * roll-up is the materializer's job and is built on this primitive.
 *
 * READ-ONLY VIEW: the returned array is a {@link Uint32Array.prototype.subarray} VIEW over the
 * index's shared `originalEdgeOrdinals` buffer (zero-copy — the hot incremental materializer
 * reads it every recut without allocating). Callers MUST NOT mutate it (no in-place sort, no
 * write): doing so corrupts the persistent cached index for every later lookup. Copy first
 * (`Uint32Array.from(...)` / spread) if you need an ownable, mutable array.
 */
export function edgesBetween(
  index: RepresentationEdgeIndex,
  repA: number,
  repB: number,
): Uint32Array {
  const min = repA < repB ? repA : repB;
  const max = repA < repB ? repB : repA;
  const k = pairIndexOf(index, min, max);
  if (k === -1) return new Uint32Array(0);
  return index.originalEdgeOrdinals.subarray(index.rangeOffsets[k], index.rangeOffsets[k + 1]);
}
