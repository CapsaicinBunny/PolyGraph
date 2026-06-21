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
 * The full hierarchy: the columnar runtime plus the convenience handles a consumer
 * needs (the source snapshot, the rep count, the roots, and the group-ordinal → rep
 * mapping). The columnar form is authoritative; the rest are derived views.
 */
export interface RepresentationHierarchy {
  /** The grouping snapshot this hierarchy was built from. */
  snapshot: CompactGroupingSnapshot;
  /** Total representations (group reps + node leaf reps). */
  repCount: number;
  /** Rep ids with no parent (root groups + orphan leaf reps). */
  roots: number[];
  /** group ordinal → its rep id (identity here, but explicit for callers). */
  repOfGroup: Int32Array;
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

  const groupCount = snapshot.groupIds.length;
  const nodeCount = snapshot.directGroupByNode.length;
  const repCount = groupCount + nodeCount;

  // Group reps occupy [0, groupCount); leaf reps occupy [groupCount, repCount).
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
    parentByRep[g] = snapshot.parentByGroup[g]; // already a group ordinal or -1
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
    parentByRep[rep] = hasGroup ? g : -1;
    nodeCost[rep] = nodeCostOf(id, i);
    edgeCost[rep] = edgeCostOf(id, i);
    labelCost[rep] = labelCostOf(id, i);
    gpuByteCost[rep] = gpuCostOf(id, i);
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

  return { snapshot, repCount, roots, repOfGroup, columns };
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
