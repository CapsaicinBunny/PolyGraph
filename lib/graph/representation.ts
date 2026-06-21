// RepresentationHierarchy — the Nanite/Horizon proxy tree (spec → "Representation
// hierarchy & budgeted LOD" + Appendix A §F). A GroupingHierarchy answers "which nodes
// belong together?"; a RepresentationHierarchy answers "at which levels can that group
// be rendered, and what does each level cost/hide?" They are DIFFERENT abstractions.
//
// The hierarchy is the grouping tree turned into a tree of cached PROXIES: every group
// becomes one representation (a proxy that stands in for its whole subtree), and every
// underlying node becomes a LEAF representation hanging under its direct group's proxy.
// A node with NO_GROUP (excluded grouping / malformed metadata) gets a leaf rep that is
// a root — so EVERY node has a representation path and nothing can evade the budget
// (the spec's safety-hierarchy guarantee; the synthetic-None grouping makes this the
// common case, but the builder is defensive regardless of the snapshot's shape).
//
// Storage is COLUMNAR (Appendix A §F): the explanatory `RepresentationNode[]` object
// model is never materialized on the hot path. The tree is `parentByRep` +
// `firstChildByRep`/`nextSiblingByRep`; ancestor tests are O(1) via DFS in/out
// intervals (`entryByRep`/`exitByRep`); costs are Uint32Array, errors Float32Array.
//
// Pure; deterministic; no React, no GPU.

import type { CompactGroupingSnapshot } from "./grouping-snapshot";
import { NO_GROUP } from "./grouping-snapshot";

/**
 * The explanatory object model of a single representation level (Appendix A: "The object
 * `RepresentationNode[]` form stays the explanatory model; the columnar form is the
 * runtime."). Not used on the hot path — {@link RepresentationColumns} is.
 */
export interface RepresentationNode {
  id: number;
  /** The group this rep proxies, or {@link NO_GROUP} for an orphan leaf rep. */
  groupId: number;
  parent: number | null;
  children: number[];
  bounds: Rect;
  nodeCost: number;
  edgeCost: number;
  labelCost: number;
  gpuByteCost: number;
  /** Information hidden when THIS proxy is shown instead of its descendants. */
  geometricError: number;
  structuralError: number;
  /** Cache key for the aggregate scene at this level. */
  proxyKey: string;
}

/** World-space rectangle (top-left origin), parallel to layout's ClusterBox. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The columnar runtime form (Appendix A §F). All arrays are indexed by rep id; the
 * group reps come first (rep id == group ordinal), then the node leaf reps. Tree links
 * use -1 as the null sentinel.
 *
 * TWO cost notions, kept distinct (the source of correctness for the budget):
 *  - `nodeCost`/`edgeCost`/`labelCost`/`gpuByteCost` are the RENDERED cost of THIS proxy
 *    LEVEL — a selected proxy draws ONE aggregate card (nodeCost 1, labelCost 1), a
 *    selected leaf draws its own node. A cut's budget cost is Σ over selected reps of
 *    these. Refining a proxy (Appendix A §D: Σ children − parent) pays the children's
 *    rendered cost minus the parent's one card.
 *  - `subtreeNodeCost`/`subtreeEdgeCost`/… are the AGGREGATE over the subtree's leaves —
 *    the cost of FULLY opening the subtree, used for error scoring and the hard-budget
 *    feasibility of a forced open.
 */
export interface RepresentationColumns {
  // ── tree ────────────────────────────────────────────────────────────────────
  parentByRep: Int32Array; // -1 = root
  firstChildByRep: Int32Array; // -1 = leaf
  nextSiblingByRep: Int32Array; // -1 = last child
  groupByRep: Uint32Array; // group ordinal proxied, or NO_GROUP for orphan leaves
  // ── geometry (parallel Float32Arrays; reserved/minScale filled by C1c) ───────
  boundsX: Float32Array;
  boundsY: Float32Array;
  boundsW: Float32Array;
  boundsH: Float32Array;
  reservedX: Float32Array;
  reservedY: Float32Array;
  reservedW: Float32Array;
  reservedH: Float32Array;
  // growth envelope — the capped maximum a box may grow to without an ancestor relayout
  // (C1c §C tiered reservation; bounds the Space Paradox). Filled by computeRepresentationBounds.
  envelopeX: Float32Array;
  envelopeY: Float32Array;
  envelopeW: Float32Array;
  envelopeH: Float32Array;
  minScale: Float32Array;
  // ── rendered per-level cost (Appendix A §D delta-cost dims) ──────────────────
  nodeCost: Uint32Array;
  edgeCost: Uint32Array;
  labelCost: Uint32Array;
  gpuByteCost: Uint32Array;
  // ── aggregate subtree cost (full-open size; error scoring; hard feasibility) ──
  subtreeNodeCost: Uint32Array;
  subtreeEdgeCost: Uint32Array;
  subtreeLabelCost: Uint32Array;
  subtreeGpuByteCost: Uint32Array;
  // ── error (info hidden when the proxy stands in for its subtree) ──────────────
  geometricError: Float32Array;
  structuralError: Float32Array;
  // ── DFS intervals — O(1) ancestor test ───────────────────────────────────────
  entryByRep: Uint32Array;
  exitByRep: Uint32Array;
  // ── cache keys ────────────────────────────────────────────────────────────────
  proxyKeys: string[];
  // ── node → its leaf rep ──────────────────────────────────────────────────────
  leafRepresentationByNode: Uint32Array;
}

/** Per-node cost inputs (Appendix A §D dims). All default to a single-card proxy. */
export interface RepresentationCosts {
  /** Layout-node cost of an underlying node (default 1 = one card). */
  nodeCost?: (nodeId: string, ordinal: number) => number;
  /** Edge cost attributable to a node (default 0; edge LOD computes the real cost). */
  edgeCost?: (nodeId: string, ordinal: number) => number;
  /** Label-draw cost of a node (default 1 = one label). */
  labelCost?: (nodeId: string, ordinal: number) => number;
  /** GPU bytes a node's geometry occupies (default 0; tuned later). */
  gpuByteCost?: (nodeId: string, ordinal: number) => number;
  /**
   * POST-FILTER visibility mask (design Gap 7 — "Cut is not clearly post-filter"). When
   * provided, a node ordinal for which this returns false is treated as HIDDEN: its leaf
   * rep is DETACHED from the hierarchy (never a child, never a root, never selectable) and
   * contributes ZERO to every cost dim. A group rep whose entire subtree is hidden likewise
   * detaches — so a proxy never exists ONLY because of filtered-out nodes, and hidden nodes
   * add no proxy-subtree cost or card-budget pressure. Omitted → every node is visible (the
   * raw-graph behavior; the snapshot is assumed already post-filter). The snapshot itself is
   * NOT rebuilt — the already-filtered community detection is reused as-is.
   */
  visibleNode?: (ordinal: number) => boolean;
  /**
   * Bootstrap-feasibility normalization (design B1 "Bootstrap feasibility" + impl note (c)).
   * When true, the natural roots (root group reps + NO_GROUP orphan leaf reps) are ADOPTED by
   * a bounded tree of synthetic SUPER-ROOT / root-bucket proxy reps so the coarsest cut —
   * {@link rootCut}, which selects EVERY root — is within the hard card budget no matter how
   * many orphans exist. Without this, a high-orphan graph starts the bootstrap antichain OVER
   * budget and (since refinement only adds cards) can never become feasible.
   *
   * The synthetic reps are appended AFTER the leaf reps (rep ids `[groupCount + nodeCount, …)`),
   * so group-rep ids (`< groupCount`) and leaf-rep ids are byte-identical to the un-normalized
   * build. Each synthetic rep obeys {@link MAX_FANOUT}; deep root sets tier into multiple
   * levels (bounded by {@link MAX_PARTITION_DEPTH}). The buckets carry NO group and NO box key
   * (render-only structural proxies). Omitted/false → the prior behavior (every natural root is
   * an independent {@link RepresentationHierarchy.roots} entry).
   */
  bootstrapRoots?: boolean;
  /**
   * Intermediate render-only proxy tiers (design B1 "Nanite-style render-only intermediate
   * proxies" + invariants (a)-(d) + impl note (c)). When true, any group rep that would directly
   * parent more than {@link MAX_FANOUT} children — counting BOTH its child group reps AND its
   * direct leaf reps (fan-out is over child count, so a directory group with many subgroups is
   * tiered even with no direct leaves) — has a BOUNDED tree of synthetic INTERMEDIATE proxy reps
   * inserted between it and those children, built by the DETERMINISTIC BALANCED-CHUNK strategy
   * (stable fan-out-bounded buckets over ascending rep-id order: child groups, then leaves in
   * canonical node order — design B1 source 4, the always-available fallback that GUARANTEES the
   * invariants).
   *
   * Why this matters: WITHOUT intermediate tiers a flat group with ~20k members parents every
   * leaf DIRECTLY, so the ONLY refinement of that group is the atomic reveal of its WHOLE leaf
   * set — which the solver's hard budget rejects, stranding the group at one aggregate card
   * forever (design B1 "the biggest gap"). The inserted tiers give refinement bounded
   * intermediate antichains to land on: a one-level refine yields the group's intermediate
   * children (≤ {@link MAX_FANOUT}), never its leaf set (invariant d).
   *
   * The intermediate reps are render-only structural proxies: NO semantic group
   * (groupByRep === {@link NO_GROUP}), one aggregate card (nodeCost/labelCost 1), no
   * box/snapshot semantics — they exist only so refinement has intermediate levels. Costs roll
   * up bottom-up unchanged (a proxy's subtree cost is still Σ of its underlying leaves). They
   * are appended alongside the bootstrap buckets at `[groupCount + nodeCount, …)`, so group-rep
   * and leaf-rep ids stay byte-identical to a build without this option. Omitted/false → the
   * prior behavior (every leaf parents DIRECTLY under its group rep, unbounded fan-out).
   */
  intermediateTiers?: boolean;
}

/**
 * Tree-link sentinel for a rep that is DETACHED from the hierarchy (a hidden leaf or an
 * empty group under the post-filter {@link RepresentationCosts.visibleNode} mask). Distinct
 * from the root sentinel (-1) so detached reps are excluded from roots, child adjacency, the
 * subtree-cost rollup, and the DFS intervals — they can never be selected by the cut. Rep
 * ids stay stable (group ordinal == rep id) regardless of how many are detached.
 */
export const DETACHED_REP = -2;

/**
 * Intermediate-tier limits (design impl note (c) — "Explicit intermediate-tier limits").
 * Named here so proxy-tier construction (the bootstrap super-root buckets in P0.5; the
 * recursive in-group intermediate tiers in P1) shares ONE set of bounds, and so they fold
 * into {@link REPRESENTATION_BUILDER_VERSION} — a change to any of them invalidates the
 * cached runtime + downstream proxy caches.
 */
export const MAX_FANOUT = 32; // max children of any rep (invariant b: no unbounded fan-out)
export const MAX_LEAVES_PER_PROXY = 128; // max leaves a single proxy may directly stand in for
export const MAX_PARTITION_DEPTH = 12; // max recursion depth of proxy-tier construction
export const MAX_PARTITION_WORK_MS = 50; // soft wall-clock budget for one partition pass

/**
 * Version of the representation BUILDER — the structure {@link buildRepresentationHierarchy}
 * emits (proxy parenting, the bootstrap super-root / root-bucket tiering, fan-out bounds, the
 * intermediate-tier limits above, and the cost rollup). The P0 persistent-runtime material
 * signature folds this in (see `lod-representation-cut.ts` → `REPRESENTATION_BUILDER_VERSION`,
 * re-exported below), so a builder change invalidates every cached `RepresentationRuntime` and
 * the downstream proxy/local-layout caches keyed off the same version. Bump on ANY change to
 * the hierarchy shape — including the tiering constants above.
 */
export const representationBuilderVersion = "rb3";

/**
 * The full hierarchy: the columnar runtime plus the convenience handles a consumer
 * needs (the source snapshot, the rep count, the roots, and the group-ordinal → rep
 * mapping). The columnar form is authoritative; the rest are derived views.
 */
export interface RepresentationHierarchy {
  /** The grouping snapshot this hierarchy was built from. */
  snapshot: CompactGroupingSnapshot;
  /** Total representations (group reps + node leaf reps + synthetic root-bucket proxies). */
  repCount: number;
  /**
   * Rep ids with no parent. WITHOUT bootstrap normalization: the natural roots (root group
   * reps + orphan leaf reps). WITH it ({@link RepresentationCosts.bootstrapRoots}): the single
   * synthetic super-root (or the bounded top tier), so the coarsest cut — {@link rootCut},
   * which selects every root — is budget-feasible regardless of orphan count (design B1
   * "Bootstrap feasibility").
   */
  roots: number[];
  /** group ordinal → its rep id (identity here, but explicit for callers). */
  repOfGroup: Int32Array;
  /**
   * The rep id of the synthetic super-root when bootstrap normalization is on and any natural
   * root exists, else -1. The super-root carries NO group (groupByRep === NO_GROUP) and NO
   * box key — it is a render-only structural proxy that adopts the natural roots so the
   * bootstrap antichain fits the hard budget. -1 when normalization is off or there are no
   * visible roots (an empty/fully-filtered graph).
   */
  superRoot: number;
  /** The columnar runtime arrays. */
  columns: RepresentationColumns;
}

/**
 * Build the representation hierarchy from a grouping snapshot and the canonical node-id
 * order. Rep ids: `[0, #groups)` are the group reps (rep id == group ordinal); then one
 * leaf rep per node in node order. Costs roll up bottom-up so every proxy carries the
 * aggregate cost of its subtree.
 */
export function buildRepresentationHierarchy(
  snapshot: CompactGroupingSnapshot,
  nodeIds: readonly string[],
  costs: RepresentationCosts = {},
): RepresentationHierarchy {
  const nodeCostOf = costs.nodeCost ?? (() => 1);
  const edgeCostOf = costs.edgeCost ?? (() => 0);
  const labelCostOf = costs.labelCost ?? (() => 1);
  const gpuCostOf = costs.gpuByteCost ?? (() => 0);
  // POST-FILTER mask (Gap 7). Detachment is applied ONLY when a mask is provided; without
  // one the hierarchy is built exactly as before (every node visible, empty groups kept as
  // roots/children) so the un-masked raw-graph behavior is byte-identical.
  const masked = typeof costs.visibleNode === "function";
  const isVisible = costs.visibleNode ?? (() => true);

  const bootstrap = costs.bootstrapRoots === true;
  const tiered = costs.intermediateTiers === true;

  const groupCount = snapshot.groupIds.length;
  const nodeCount = snapshot.directGroupByNode.length;
  // Group reps occupy [0, groupCount); leaf reps occupy [groupCount, baseRepCount). Synthetic
  // root-bucket proxies (bootstrap normalization) are appended at [baseRepCount, repCount) so
  // group/leaf rep ids are byte-identical to the un-normalized build.
  const baseRepCount = groupCount + nodeCount;

  // Group reps occupy [0, groupCount); leaf reps occupy [groupCount, baseRepCount).
  const leafRepOf = (nodeOrdinal: number) => groupCount + nodeOrdinal;

  // POST-FILTER detachment (Gap 7). A leaf rep is detached iff its node is hidden; a group
  // rep is detached iff NONE of its descendant VISIBLE leaves exist. Detached reps are wired
  // as neither child nor root, contribute zero cost, and can never be selected — so hidden
  // nodes add no subtree/card pressure and no proxy exists only because of hidden nodes.
  // `groupHasVisible[g]` is rolled up over the GROUP parent chain (parentByGroup), the only
  // structure available before the rep tree is built. When unmasked every entry is 1 (no
  // detachment), preserving the prior treatment of genuinely-empty groups.
  const groupHasVisible = new Uint8Array(groupCount);
  if (!masked) {
    groupHasVisible.fill(1);
  } else {
    for (let i = 0; i < nodeCount; i++) {
      if (!isVisible(i)) continue;
      const g = snapshot.directGroupByNode[i];
      if (g === NO_GROUP || g >= groupCount) continue;
      let cur = g;
      let guard = groupCount + 1;
      while (cur !== -1 && guard-- > 0) {
        if (groupHasVisible[cur]) break; // ancestors already marked — stop early
        groupHasVisible[cur] = 1;
        cur = snapshot.parentByGroup[cur];
      }
    }
  }

  // BOOTSTRAP FEASIBILITY (design B1). Collect the NATURAL roots — the reps that would each
  // be an independent root WITHOUT normalization: every attached root group rep (parent -1,
  // has visible members) and every attached NO_GROUP orphan leaf rep. A high-orphan graph has
  // O(nodeCount) of these, so the un-normalized bootstrap antichain (rootCut selects them all)
  // starts OVER budget. We plan a bounded tier of synthetic proxies that ADOPT them, computed
  // BEFORE allocation so the typed arrays are sized once for the appended reps.
  const naturalRoots: number[] = [];
  if (bootstrap) {
    for (let g = 0; g < groupCount; g++) {
      if (groupHasVisible[g] === 0) continue; // detached — never a root
      if (snapshot.parentByGroup[g] === -1) naturalRoots.push(g);
    }
    for (let i = 0; i < nodeCount; i++) {
      if (!isVisible(i)) continue; // detached leaf — never a root
      const g = snapshot.directGroupByNode[i];
      if (g === NO_GROUP || g >= groupCount) naturalRoots.push(leafRepOf(i)); // orphan leaf
    }
  }
  // INTERMEDIATE TIERS (design B1). Collect, for every group rep that would directly parent
  // more than MAX_FANOUT children, ALL of its direct children — its CHILD GROUP reps AND its
  // direct VISIBLE leaf reps — then plan a bounded balanced-chunk tree of render-only
  // intermediate proxies between the group and those children. Without this, a flat group with
  // thousands of members can only refine by atomically revealing its WHOLE child set — which the
  // solver's hard budget rejects, stranding the group at one card (design B1 "the biggest gap").
  //
  // A group rep's fan-out is NOT leaf-only: nested groups parent onto their group rep via
  // `parentByGroup` (set at the group loop below to `snapshot.parentByGroup[g]`), so a directory
  // group with >MAX_FANOUT SUBGROUPS exceeds the bound even with zero direct leaves. Invariant (b)
  // is over CHILD COUNT, so both kinds of child must be tiered together. Children are collected in
  // ASCENDING rep-id order — child-group reps first (ids < groupCount), then leaf reps in canonical
  // node order (ids ≥ groupCount) — matching the firstChild/nextSibling adjacency order built later
  // so the planned chunks are contiguous in that order. Planned BEFORE allocation so the appended
  // intermediate reps are sized into the typed arrays. NOTE: orphan-leaf / root-group fan-out is
  // bounded by the bootstrap buckets (each ≤MAX_FANOUT) — only semantic groups need tiering here.
  const groupDirectChildren = new Map<number, number[]>();
  if (tiered) {
    // (1) Child GROUP reps — appended first so they sort ahead of every leaf rep (group ids are
    //     all < groupCount ≤ every leaf rep id). A detached child group (no visible members) is
    //     never wired into the tree, so it is not a child here either.
    for (let g = 0; g < groupCount; g++) {
      if (groupHasVisible[g] === 0) continue; // detached — never a child
      const p = snapshot.parentByGroup[g];
      if (p === -1 || p >= groupCount) continue; // root group — not a child of any group rep
      let list = groupDirectChildren.get(p);
      if (list === undefined) groupDirectChildren.set(p, (list = []));
      list.push(g);
    }
    // (2) Direct leaf reps in canonical node order (leaf rep ids ascend with node ordinal, so the
    //     existing group-first ordering is preserved by appending after the child-group reps).
    for (let i = 0; i < nodeCount; i++) {
      if (!isVisible(i)) continue; // detached leaf — never a child
      const g = snapshot.directGroupByNode[i];
      if (g === NO_GROUP || g >= groupCount) continue; // orphan — handled by buckets, not tiers
      let list = groupDirectChildren.get(g);
      if (list === undefined) groupDirectChildren.set(g, (list = []));
      list.push(leafRepOf(i));
    }
    // Drop groups that are already bounded so planIntermediateTiers only sees oversized parents.
    for (const [g, list] of groupDirectChildren) {
      if (list.length <= MAX_FANOUT) groupDirectChildren.delete(g);
    }
  }
  const inter = planIntermediateTiers(groupDirectChildren, baseRepCount);

  // Plan the synthetic super-root / root-bucket tier over the natural roots (deterministic,
  // fan-out-bounded). `plan.count === 0` → no normalization needed (off, or ≤0 natural roots).
  // Bucket reps are appended AFTER the intermediate-tier reps (which start at baseRepCount), so
  // both kinds of synthetic proxy coexist with byte-identical group/leaf rep ids.
  const bucketBase = baseRepCount + inter.count;
  const plan = planRootBuckets(naturalRoots, bucketBase);
  const repCount = bucketBase + plan.count;

  const parentByRep = new Int32Array(repCount).fill(-1);
  const groupByRep = new Uint32Array(repCount);
  const nodeCost = new Uint32Array(repCount);
  const edgeCost = new Uint32Array(repCount);
  const labelCost = new Uint32Array(repCount);
  const gpuByteCost = new Uint32Array(repCount);
  const subtreeNodeCost = new Uint32Array(repCount);
  const subtreeEdgeCost = new Uint32Array(repCount);
  const subtreeLabelCost = new Uint32Array(repCount);
  const subtreeGpuByteCost = new Uint32Array(repCount);
  const geometricError = new Float32Array(repCount);
  const structuralError = new Float32Array(repCount);
  const proxyKeys: string[] = new Array(repCount);
  const leafRepresentationByNode = new Uint32Array(nodeCount);

  // Group reps: parent from the snapshot's parentByGroup; proxyKey from the group id. A
  // selected proxy renders as ONE aggregate card → rendered nodeCost/labelCost = 1, no
  // edges/gpu of its own. The subtree* aggregate is rolled up below.
  for (let g = 0; g < groupCount; g++) {
    groupByRep[g] = g;
    proxyKeys[g] = `${snapshot.modeKey}|${snapshot.groupIds[g]}`;
    if (groupHasVisible[g] === 0) {
      // Empty under the post-filter mask — detach (no proxy from hidden nodes alone).
      parentByRep[g] = DETACHED_REP;
      continue;
    }
    // A child group under an OVERSIZED parent group is re-parented onto its planned intermediate
    // proxy (design B1 invariant b — fan-out is over CHILD COUNT, which includes subgroups), else
    // it parents directly onto its parent group rep (or -1 for a root). Its rep id is unchanged.
    const interParent = inter.parentByChild.get(g);
    parentByRep[g] = interParent !== undefined ? interParent : snapshot.parentByGroup[g];
    nodeCost[g] = 1; // one aggregate card
    labelCost[g] = 1; // one proxy label
  }

  // Leaf reps: one per node, parented to its direct group rep (or a root for NO_GROUP).
  // A leaf's rendered cost IS the node's own cost.
  for (let i = 0; i < nodeCount; i++) {
    const rep = leafRepOf(i);
    leafRepresentationByNode[i] = rep;
    const g = snapshot.directGroupByNode[i];
    const hasGroup = g !== NO_GROUP && g < groupCount;
    const id = nodeIds[i] ?? String(i);
    groupByRep[rep] = hasGroup ? g : NO_GROUP;
    proxyKeys[rep] = `${snapshot.modeKey}|node|${id}`;
    if (!isVisible(i)) {
      // Hidden under the post-filter mask — detach, zero cost (no card/layout pressure).
      parentByRep[rep] = DETACHED_REP;
      continue;
    }
    // A leaf under an OVERSIZED group is re-parented onto its planned intermediate proxy (design
    // B1); otherwise it parents directly under its group rep (or -1 for an orphan, which the
    // bootstrap buckets adopt). The leaf's rep id and cost are unchanged either way.
    const interParent = inter.parentByChild.get(rep);
    parentByRep[rep] = interParent !== undefined ? interParent : hasGroup ? g : -1;
    nodeCost[rep] = nodeCostOf(id, i);
    edgeCost[rep] = edgeCostOf(id, i);
    labelCost[rep] = labelCostOf(id, i);
    gpuByteCost[rep] = gpuCostOf(id, i);
  }

  // INTERMEDIATE-TIER wiring (design B1). Each intermediate rep is render-only — NO group
  // (groupByRep === NO_GROUP), one aggregate card (nodeCost/labelCost 1), no edges/gpu of its
  // own — exactly like a group proxy's per-level cost; its subtree cost rolls up below. Its
  // parent is another intermediate rep or the original oversized group rep (planIntermediateTiers
  // stamps parentOf accordingly). The leaves it adopts were re-parented in the leaf loop above.
  for (let k = 0; k < inter.count; k++) {
    const rep = baseRepCount + k;
    parentByRep[rep] = inter.parentOf[k]; // intermediate rep, or the original group rep
    groupByRep[rep] = NO_GROUP; // render-only structural proxy — no semantic group
    nodeCost[rep] = 1; // one aggregate card
    labelCost[rep] = 1; // one proxy label
    proxyKeys[rep] = `${snapshot.modeKey}|tier|${k}`;
  }

  // BOOTSTRAP super-root / root-bucket wiring (design B1). Re-parent each natural root onto
  // its planned synthetic bucket, then wire the synthetic reps themselves. A synthetic proxy
  // is render-only: NO group (groupByRep === NO_GROUP), one aggregate card (nodeCost 1, one
  // label), no edges/gpu of its own — exactly like a group proxy's per-level cost. Its subtree
  // cost rolls up below. The super-root becomes the sole entry in `roots`, so the coarsest cut
  // is one card regardless of orphan count (invariant a). Bucket rep ids start at `bucketBase`
  // (== baseRepCount + inter.count), after the intermediate-tier reps.
  let superRoot = -1;
  if (plan.count > 0) {
    superRoot = plan.superRoot;
    // Re-parent natural roots (they were wired to -1 above) onto their bucket.
    for (const [nat, bucket] of plan.bucketByNaturalRoot) parentByRep[nat] = bucket;
    // Wire each synthetic rep: parent from the plan, render-only single-card cost.
    for (let k = 0; k < plan.count; k++) {
      const rep = bucketBase + k;
      parentByRep[rep] = plan.parentOf[k]; // another synthetic rep, or -1 for the super-root
      groupByRep[rep] = NO_GROUP; // render-only structural proxy — no semantic group
      nodeCost[rep] = 1; // one aggregate card
      labelCost[rep] = 1; // one proxy label
      proxyKeys[rep] = `${snapshot.modeKey}|bucket|${k}`;
    }
  }

  // Build child adjacency as firstChild/nextSibling. Children are kept in ASCENDING
  // rep-id order (group reps before leaf reps under the same parent — group ordinals are
  // all < leaf rep ids), so enumeration is deterministic. Iterate parents descending so
  // the prepend yields ascending sibling order.
  const firstChildByRep = new Int32Array(repCount).fill(-1);
  const nextSiblingByRep = new Int32Array(repCount).fill(-1);
  const roots: number[] = [];
  for (let r = repCount - 1; r >= 0; r--) {
    const p = parentByRep[r];
    if (p < 0) continue; // -1 root or -2 DETACHED_REP — no parent link
    nextSiblingByRep[r] = firstChildByRep[p];
    firstChildByRep[p] = r;
  }
  // Roots are reps with NO parent — but a DETACHED_REP (-2) is excluded from the tree
  // entirely (it is not a root, so the cut never selects it and it costs nothing).
  for (let r = 0; r < repCount; r++) if (parentByRep[r] === -1) roots.push(r);

  // Aggregate subtree cost = the cost of FULLY opening the subtree (Σ over its leaves).
  // Seed every rep's subtree* with its OWN leaf cost (proxies contribute 0 of their own —
  // they aren't leaves), then roll leaf costs up via a post-order over the child links
  // (iterative, deep-safe; no assumption about snapshot id ordering). A proxy's subtree
  // node cost is thus the count/weight of underlying nodes it would expand to.
  const order = postOrder(repCount, roots, firstChildByRep, nextSiblingByRep);
  for (let r = 0; r < repCount; r++) {
    const isLeaf = firstChildByRep[r] === -1;
    subtreeNodeCost[r] = isLeaf ? nodeCost[r] : 0;
    subtreeEdgeCost[r] = isLeaf ? edgeCost[r] : 0;
    subtreeLabelCost[r] = isLeaf ? labelCost[r] : 0;
    subtreeGpuByteCost[r] = isLeaf ? gpuByteCost[r] : 0;
  }
  for (const r of order) {
    const p = parentByRep[r];
    if (p === -1) continue;
    subtreeNodeCost[p] += subtreeNodeCost[r];
    subtreeEdgeCost[p] += subtreeEdgeCost[r];
    subtreeLabelCost[p] += subtreeLabelCost[r];
    subtreeGpuByteCost[p] += subtreeGpuByteCost[r];
  }

  // Geometric/structural error: how much information a proxy hides. A starting heuristic
  // (the spec's "tune against real repos behind telemetry"): a proxy hides its descendant
  // nodes, so geometricError ≈ log2(1 + subtree leaf count) and structuralError ≈ the
  // subtree's internal edge cost. Leaf reps hide nothing → 0. Reuses the post-order above.
  {
    const subtreeLeaves = new Uint32Array(repCount);
    for (const r of order) {
      if (firstChildByRep[r] === -1) subtreeLeaves[r] = 1;
      const p = parentByRep[r];
      if (p !== -1) subtreeLeaves[p] += subtreeLeaves[r];
    }
    for (let r = 0; r < repCount; r++) {
      if (firstChildByRep[r] === -1) {
        geometricError[r] = 0;
        structuralError[r] = 0;
      } else {
        geometricError[r] = Math.log2(1 + subtreeLeaves[r]);
        structuralError[r] = subtreeEdgeCost[r];
      }
    }
  }

  // DFS in/out intervals — O(1) ancestor test (Appendix A §F). One iterative DFS over the
  // roots (ascending) assigns entry on first visit and exit on completion.
  const entryByRep = new Uint32Array(repCount);
  const exitByRep = new Uint32Array(repCount);
  assignDfsIntervals(roots, firstChildByRep, nextSiblingByRep, entryByRep, exitByRep);

  // Geometry columns start empty (filled by C1c's stable hierarchical layout). Zeroed.
  const z = () => new Float32Array(repCount);

  const repOfGroup = new Int32Array(groupCount);
  for (let g = 0; g < groupCount; g++) repOfGroup[g] = g;

  const columns: RepresentationColumns = {
    parentByRep,
    firstChildByRep,
    nextSiblingByRep,
    groupByRep,
    boundsX: z(),
    boundsY: z(),
    boundsW: z(),
    boundsH: z(),
    reservedX: z(),
    reservedY: z(),
    reservedW: z(),
    reservedH: z(),
    envelopeX: z(),
    envelopeY: z(),
    envelopeW: z(),
    envelopeH: z(),
    minScale: new Float32Array(repCount).fill(1),
    nodeCost,
    edgeCost,
    labelCost,
    gpuByteCost,
    subtreeNodeCost,
    subtreeEdgeCost,
    subtreeLabelCost,
    subtreeGpuByteCost,
    geometricError,
    structuralError,
    entryByRep,
    exitByRep,
    proxyKeys,
    leafRepresentationByNode,
  };

  return { snapshot, repCount, roots, repOfGroup, superRoot, columns };
}

/**
 * Plan the synthetic super-root / root-bucket tier over the natural roots (design B1 +
 * impl note (c)). Deterministic and fan-out-bounded: the natural roots are partitioned into
 * contiguous chunks of at most {@link MAX_FANOUT}, each chunk adopted by one new synthetic
 * proxy; that level is partitioned again, repeating until one level remains, which a single
 * SUPER-ROOT adopts. The result is one root (the super-root), so the bootstrap antichain is
 * one card (invariant a) and no rep exceeds {@link MAX_FANOUT} children (invariant b).
 *
 * Synthetic rep ids are assigned bottom-up starting at `base` (== baseRepCount), so the
 * deepest buckets get the lowest synthetic ids; this keeps the assignment deterministic and
 * independent of the natural-root values. To keep ONE uniform feasibility guarantee we wrap
 * even a single natural root in a super-root (so `rootCut` is always exactly one card).
 * `count === 0` ONLY when there are NO natural roots at all (an empty / fully-filtered graph).
 *
 * {@link MAX_PARTITION_DEPTH} caps the tiering: with fan-out 32 and depth 12 the tree spans
 * 32^12 (~1.15e18) roots, far beyond any real graph, so the cap is a safety bound, not a
 * functional limit. If it is ever hit, the final super-root adopts the remaining level
 * directly (a wider-than-MAX_FANOUT top level is preferred over an unbounded-depth tree).
 */
function planRootBuckets(
  naturalRoots: readonly number[],
  base: number,
): {
  count: number;
  superRoot: number;
  /** synthetic index k → parent rep id (another synthetic rep, or -1 for the super-root). */
  parentOf: Int32Array;
  /** natural root rep id → the synthetic rep id that adopts it. */
  bucketByNaturalRoot: Map<number, number>;
} {
  const empty = {
    count: 0,
    superRoot: -1,
    parentOf: new Int32Array(0),
    bucketByNaturalRoot: new Map<number, number>(),
  };
  if (naturalRoots.length === 0) return empty;

  // Two passes: (1) size the tiers to assign stable synthetic ids bottom-up; (2) emit the
  // parent links. We accumulate synthetic reps in a temporary list; each entry records its
  // children (rep ids — natural or already-created synthetic) so we can stamp parents after
  // all ids are known.
  const childrenOfSynthetic: number[][] = [];
  const newSynthetic = (children: number[]): number => {
    const id = base + childrenOfSynthetic.length;
    childrenOfSynthetic.push(children);
    return id;
  };

  // Bottom-up: partition the current level into ≤MAX_FANOUT chunks until one level remains.
  let level: number[] = [...naturalRoots];
  let depth = 0;
  while (level.length > MAX_FANOUT && depth < MAX_PARTITION_DEPTH) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += MAX_FANOUT) {
      next.push(newSynthetic(level.slice(i, i + MAX_FANOUT)));
    }
    level = next;
    depth++;
  }
  // One super-root adopts the final level (≤MAX_FANOUT, unless MAX_PARTITION_DEPTH was hit —
  // then it adopts the remainder directly, a bounded-depth/over-fan trade the doc-comment notes).
  const superRoot = newSynthetic(level);

  const count = childrenOfSynthetic.length;
  const parentOf = new Int32Array(count).fill(-1); // default: the super-root's own parent is -1
  const bucketByNaturalRoot = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const synthId = base + k;
    for (const child of childrenOfSynthetic[k]) {
      // A child < base is a natural root (group/leaf rep); ≥ base is a lower synthetic tier.
      if (child < base) bucketByNaturalRoot.set(child, synthId);
      else parentOf[child - base] = synthId;
    }
  }
  return { count, superRoot, parentOf, bucketByNaturalRoot };
}

/**
 * Plan a bounded tree of render-only INTERMEDIATE proxy reps for every oversized parent
 * (design B1 "Nanite-style render-only intermediate proxies" + invariants (a)-(d) + impl
 * note (c)). A parent is OVERSIZED when it would directly parent more than {@link MAX_FANOUT}
 * children, or stand in for more than {@link MAX_LEAVES_PER_PROXY} leaves. Each oversized
 * parent's direct children are partitioned by the DETERMINISTIC BALANCED-CHUNK strategy
 * (design B1 source 4): contiguous chunks of ≤{@link MAX_FANOUT} over the children IN THE
 * GIVEN ORDER (the canonical node order for a group's leaves), each chunk adopted by one new
 * synthetic intermediate proxy, repeated bottom-up until the top level is ≤{@link MAX_FANOUT}
 * — which the original parent then adopts directly. The balanced-chunk fallback is always
 * available and GUARANTEES the invariants: every rep ends with ≤{@link MAX_FANOUT} children
 * (b) and a one-level refine of the parent yields its bounded intermediate children, never its
 * whole leaf set (d). With chunk size {@link MAX_FANOUT} ≤ {@link MAX_LEAVES_PER_PROXY}, a
 * bottom-tier proxy stands in for ≤{@link MAX_FANOUT} leaves, so the leaf-per-proxy bound holds.
 *
 * The intermediate reps are appended at `[base, base + count)`; like the bootstrap buckets they
 * carry NO group and a single-card render cost (stamped by the caller). `parentByChild` maps a
 * direct child rep id (a leaf, in the P0.5 group case) to the bottom intermediate proxy that now
 * adopts it; `parentOf[k]` maps intermediate index k to its parent — another intermediate rep,
 * or the ORIGINAL parent rep id (`< base`) for the top tier. `count === 0` when no parent is
 * oversized (every parent already ≤{@link MAX_FANOUT} children — the small-graph common case).
 *
 * {@link MAX_PARTITION_DEPTH} caps the tiering (a safety bound; fan-out 32 × depth 12 spans
 * ~1.15e18 leaves). If hit, the original parent adopts the remaining (wider-than-MAX_FANOUT)
 * level directly — a bounded-depth/over-fan trade, mirroring {@link planRootBuckets}.
 */
function planIntermediateTiers(
  childrenByParent: ReadonlyMap<number, readonly number[]>,
  base: number,
): {
  count: number;
  /** synthetic index k → parent rep id (another intermediate rep, or the original parent < base). */
  parentOf: Int32Array;
  /** original direct child rep id → the intermediate rep id that now adopts it. */
  parentByChild: Map<number, number>;
} {
  // Accumulate synthetic reps. `parentOf` is filled directly as ids are assigned (each new
  // proxy's parent is known by the time the level above it is built); the top tier's parent is
  // the original oversized parent rep, stamped when that parent adopts the final level.
  let count = 0;
  const parentOfList: number[] = [];
  const newSynthetic = (parent: number): number => {
    const id = base + count++;
    parentOfList.push(parent); // re-stamped by the tier above; the top tier keeps `parent`
    return id;
  };

  const parentByChild = new Map<number, number>();
  for (const [parent, directChildren] of childrenByParent) {
    if (directChildren.length <= MAX_FANOUT) continue; // already bounded — no tier needed

    // Bottom tier: chunk the direct children into ≤MAX_FANOUT contiguous buckets (canonical
    // order preserved). Each child is re-parented onto its chunk's new intermediate proxy. The
    // proxy's own parent is provisionally `parent` (corrected below if more tiers are added).
    let level: number[] = [];
    for (let i = 0; i < directChildren.length; i += MAX_FANOUT) {
      const proxy = newSynthetic(parent);
      for (let j = i; j < Math.min(i + MAX_FANOUT, directChildren.length); j++) {
        parentByChild.set(directChildren[j], proxy);
      }
      level.push(proxy);
    }
    // Coarsen further while the tier itself exceeds MAX_FANOUT (the original parent must end
    // with ≤MAX_FANOUT children too — invariant b applies to the semantic group, not just the
    // intermediate reps). Bounded by MAX_PARTITION_DEPTH.
    let depth = 1;
    while (level.length > MAX_FANOUT && depth < MAX_PARTITION_DEPTH) {
      const next: number[] = [];
      for (let i = 0; i < level.length; i += MAX_FANOUT) {
        const proxy = newSynthetic(parent);
        for (let j = i; j < Math.min(i + MAX_FANOUT, level.length); j++) {
          parentOfList[level[j] - base] = proxy; // the lower tier now parents onto this proxy
        }
        next.push(proxy);
      }
      level = next;
      depth++;
    }
    // The remaining `level` is the top tier; its proxies keep `parent` (the original oversized
    // rep) as their parentOf — already stamped by newSynthetic, so nothing more to do.
  }

  return { count, parentOf: Int32Array.from(parentOfList), parentByChild };
}

/**
 * O(1) ancestor test via DFS intervals (Appendix A §F):
 * `entry[A] <= entry[B] && exit[B] <= exit[A]`. Reflexive (A is its own ancestor here),
 * matching `representativeOf`'s "walk from the leaf, stop at the first selected rep
 * (possibly the leaf itself)".
 */
export function isRepAncestor(cols: RepresentationColumns, a: number, b: number): boolean {
  return cols.entryByRep[a] <= cols.entryByRep[b] && cols.exitByRep[b] <= cols.exitByRep[a];
}

/**
 * The representative of an underlying node under a cut: walk `parentByRep` from the
 * node's leaf rep up to the root, returning the FIRST (deepest) selected rep. Returns
 * -1 when no rep on the path is selected (the caller treats the node as not represented
 * — a valid cut never leaves this case, but a partial/invalid cut can). O(depth).
 */
export function representativeOf(
  h: RepresentationHierarchy,
  nodeOrdinal: number,
  isSelected: (rep: number) => boolean,
): number {
  const { parentByRep, leafRepresentationByNode } = h.columns;
  let cur = leafRepresentationByNode[nodeOrdinal];
  let guard = h.repCount + 1;
  // Stop on any negative sentinel: -1 root or -2 DETACHED_REP (a hidden leaf under the
  // post-filter mask has no representative — it is not in the rendered scene).
  while (cur >= 0 && guard-- > 0) {
    if (isSelected(cur)) return cur;
    cur = parentByRep[cur];
  }
  return -1;
}

// ── internals ──────────────────────────────────────────────────────────────────

/** Iterative post-order traversal (children before parent), deep-safe. */
function postOrder(
  repCount: number,
  roots: readonly number[],
  firstChild: Int32Array,
  nextSibling: Int32Array,
): number[] {
  const order: number[] = [];
  // Two-stack post-order: push, emit in reverse of a pre-order that visits children
  // first→last; reversing gives children-before-parent.
  const stack: number[] = [...roots];
  const out: number[] = [];
  while (stack.length > 0) {
    const r = stack.pop()!;
    out.push(r);
    for (let c = firstChild[r]; c !== -1; c = nextSibling[c]) stack.push(c);
  }
  for (let i = out.length - 1; i >= 0; i--) order.push(out[i]);
  return order;
}

/**
 * Assign DFS entry/exit indices over the forest. Iterative (explicit stack) so a deep
 * hierarchy can't overflow. `entry` is a pre-order counter; `exit` is assigned when a
 * subtree completes, so `[entry, exit]` nests for ancestors.
 */
function assignDfsIntervals(
  roots: readonly number[],
  firstChild: Int32Array,
  nextSibling: Int32Array,
  entry: Uint32Array,
  exit: Uint32Array,
): void {
  let clock = 0;
  // Frame: (rep, childCursor). entry is stamped when a rep is FIRST pushed (so each
  // root's whole subtree completes before the next root begins — sibling intervals must
  // not interleave). exit is stamped when the rep's child cursor is exhausted. A virtual
  // root cursor walks `roots` left→right so the first root gets the smallest entry.
  const stack: { rep: number; child: number }[] = [];
  let rootCursor = 0;
  const pushRep = (r: number) => {
    entry[r] = clock++;
    stack.push({ rep: r, child: firstChild[r] });
  };
  if (rootCursor < roots.length) pushRep(roots[rootCursor++]);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.child === -1) {
      exit[frame.rep] = clock++;
      stack.pop();
      // When the forest's current tree finishes, start the next root.
      if (stack.length === 0 && rootCursor < roots.length) pushRep(roots[rootCursor++]);
      continue;
    }
    const c = frame.child;
    frame.child = nextSibling[c];
    pushRep(c);
  }
}
