import { describe, expect, test } from "bun:test";
import {
  buildRepresentationEdgeIndex,
  buildRepresentationHierarchy,
  type EdgeIndexInput,
  type RepresentationHierarchy,
} from "./representation";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  type LodBudget,
  type LodCut,
  solveLodCut,
} from "./lod-cut-solver";
import type { CompactGroupingSnapshot } from "./grouping-snapshot";

// ── Spec B2 "Marginal edge delta" ────────────────────────────────────────────
//
// The solver's edge gate must price a `parent → children` refinement by its ACTUAL marginal
// delta in the active quotient graph (the cross-child boundary edges that become newly-visible
// once both children are co-selected), computed from the edge index's boundary summaries — NOT
// the inert additive per-rep edgeCost (default 0). A refine that EXPLODES boundary edges is
// rejected by the edge budget; a benign one (few/no cross-child edges) passes. Deterministic.

const cam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };
const noConstraints: CutConstraints = { forceClosed: new Set(), forceOpen: new Set() };

/**
 * A flat snapshot: ONE root group "g" with `n` leaf children, so every leaf is a sibling under
 * the group rep. Refining the group rep reveals the cross-LEAF quotient edges — the boundary the
 * marginal edge delta must price. (Two roots would need bootstrap normalization for a common
 * ancestor; one group keeps the LCA of any two leaves at the group rep, which is what we want.)
 */
function oneGroupSnapshot(n: number): CompactGroupingSnapshot {
  const directGroupByNode = new Uint32Array(n); // every node → group 0
  return {
    modeKey: "synthetic",
    groupIds: ["g:all"],
    groupLabels: ["all"],
    parentByGroup: Int32Array.from([-1]),
    depthByGroup: Uint16Array.from([0]),
    boxKeyByGroup: ["box:all"],
    directGroupByNode,
    roots: Uint32Array.from([0]),
  };
}

function buildOneGroup(n: number): {
  h: RepresentationHierarchy;
  groupRep: number;
  leafRep: (i: number) => number;
} {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const h = buildRepresentationHierarchy(oneGroupSnapshot(n), ids);
  return {
    h,
    groupRep: h.repOfGroup[0],
    leafRep: (i: number) => h.columns.leafRepresentationByNode[i],
  };
}

/** Edge by node ordinal, kind 0. */
const e = (source: number, target: number, weight = 1): EdgeIndexInput => ({
  source,
  target,
  kind: 0,
  weight,
});

/** A clique over node ordinals [0, n): every distinct pair gets one edge → C(n,2) edges. */
function clique(n: number): EdgeIndexInput[] {
  const out: EdgeIndexInput[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push(e(i, j));
  return out;
}

/** A finite budget whose EDGE ceiling is the binding dimension under test (others huge-finite). */
function edgeGatedBudget(hardEdges: number, targetEdges = hardEdges): LodBudget {
  return {
    targetCards: 100000,
    hardCards: 100000,
    targetLayoutCost: 1_000_000,
    hardLayoutCost: 1_000_000,
    targetEdges,
    hardEdges,
    targetLabels: 1_000_000,
    hardLabels: 1_000_000,
    maxGpuBytes: 1_000_000_000,
  };
}

describe("solveLodCut — marginal quotient-edge gate (Spec B2)", () => {
  test("a refine that EXPLODES boundary edges is rejected by the edge budget", () => {
    // 8 leaves fully interconnected → refining the group reveals C(8,2) = 28 cross-child
    // quotient edges. CARDS/layout have ample room; only EDGES gates. hardEdges = 10 < 28, so
    // the refine MUST be rejected — the group stays as one aggregate card.
    const { h, groupRep, leafRep } = buildOneGroup(8);
    const idx = buildRepresentationEdgeIndex(h, clique(8));
    const budget = edgeGatedBudget(10);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    const selected = new Set(cut.selectedRepresentations);
    // The group was NOT refined — its leaves would blow past hardEdges.
    expect(selected.has(groupRep)).toBe(true);
    expect(selected.has(leafRep(0))).toBe(false);
    // Edge cost stayed within the finite ceiling (no silent explosion).
    expect(cut.edgeCost).toBeLessThanOrEqual(budget.hardEdges);
  });

  test("a BENIGN refine (few cross-child edges) passes the edge budget", () => {
    // Same 8 leaves but only a single chain of 3 edges among them → refining reveals just 3
    // cross-child quotient edges, well under hardEdges = 10, so the group DOES refine.
    const { h, groupRep, leafRep } = buildOneGroup(8);
    const idx = buildRepresentationEdgeIndex(h, [e(0, 1), e(2, 3), e(4, 5)]);
    const budget = edgeGatedBudget(10);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    const selected = new Set(cut.selectedRepresentations);
    // The group WAS refined to its leaves (the benign edge cost fit the budget).
    expect(selected.has(groupRep)).toBe(false);
    expect(selected.has(leafRep(0))).toBe(true);
    expect(selected.has(leafRep(7))).toBe(true);
    // 3 distinct cross-child quotient edges are now visible — exactly the marginal delta.
    expect(cut.edgeCost).toBe(3);
    expect(cut.edgeCost).toBeLessThanOrEqual(budget.hardEdges);
  });

  test("the same explosion PASSES once the edge ceiling is raised to fit it", () => {
    // Proves it is the EDGE budget (not some other dimension) gating the dense refine: raise
    // hardEdges above C(8,2)=28 and the same clique now refines fully.
    const { h, groupRep } = buildOneGroup(8);
    const idx = buildRepresentationEdgeIndex(h, clique(8));
    const budget = edgeGatedBudget(100);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(groupRep)).toBe(false); // refined now
    expect(cut.edgeCost).toBe(28); // C(8,2) distinct cross-child quotient edges
  });

  test("WITHOUT an edge index the additive per-rep edgeCost (0) leaves the edge budget inert", () => {
    // Regression on the gap the index closes: with no index the same dense clique refine is
    // NOT charged its real Δedges — the additive default-0 edgeCost lets it through even under
    // a hardEdges far below the explosion. (This documents the old, inert behavior.)
    const { h, groupRep } = buildOneGroup(8);
    const budget = edgeGatedBudget(10);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget /* no edgeIndex */);
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(groupRep)).toBe(false); // refined — the edge budget did not bite
    expect(cut.edgeCost).toBe(0); // additive per-rep edgeCost default
  });

  test("the marginal delta is computed against CO-SELECTED reps, not a static per-rep number", () => {
    // Two independent groups, each a clique. Force-open only group A (revealing its dense
    // cross-child edges) while group B stays a single proxy. The visible quotient edge count
    // reflects ONLY the co-selected (opened) region — B's internal clique edges are NOT counted
    // while B is folded. This is the cut-DEPENDENT property the index provides.
    const n = 5; // per group
    const ids = Array.from({ length: 2 * n }, (_, i) => `n${i}`);
    const directGroupByNode = new Uint32Array(2 * n);
    for (let i = 0; i < n; i++) directGroupByNode[i] = 0;
    for (let i = 0; i < n; i++) directGroupByNode[n + i] = 1;
    const snap: CompactGroupingSnapshot = {
      modeKey: "synthetic",
      groupIds: ["g:A", "g:B"],
      groupLabels: ["A", "B"],
      parentByGroup: Int32Array.from([-1, -1]),
      depthByGroup: Uint16Array.from([0, 0]),
      boxKeyByGroup: ["box:A", "box:B"],
      directGroupByNode,
      roots: Uint32Array.from([0, 1]),
    };
    // Bootstrap so A and B share a synthetic super-root — required for the edge index to have a
    // common ancestor for any cross-group pairing (here there are none; both cliques are internal).
    const h = buildRepresentationHierarchy(snap, ids, { bootstrapRoots: true });
    const aClique: EdgeIndexInput[] = [];
    const bClique: EdgeIndexInput[] = [];
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        aClique.push(e(i, j));
        bClique.push(e(n + i, n + j));
      }
    const idx = buildRepresentationEdgeIndex(h, [...aClique, ...bClique]);
    const aRep = h.repOfGroup[0];
    const bRep = h.repOfGroup[1];
    const budget = edgeGatedBudget(1000);
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set([bRep]), forceOpen: new Set([aRep]) },
      cam,
      budget,
      { edgeIndex: idx },
    );
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(aRep)).toBe(false); // A opened
    expect(selected.has(bRep)).toBe(true); // B folded
    // Only A's C(5,2)=10 cross-child edges are visible; B's clique stays invisible (folded).
    expect(cut.edgeCost).toBe(10);
  });

  test("deterministic: two solves of the same inputs yield byte-identical cuts and edge cost", () => {
    const { h } = buildOneGroup(8);
    const idx = buildRepresentationEdgeIndex(h, clique(8));
    const budget = edgeGatedBudget(40);
    const run = (): LodCut =>
      solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    const c1 = run();
    const c2 = run();
    expect([...c1.selectedRepresentations]).toEqual([...c2.selectedRepresentations]);
    expect(c1.edgeCost).toBe(c2.edgeCost);
  });

  // ── Multi-tier correctness (regression for the boundary-pair undercount bug) ────────────
  //
  // The first implementation priced a refine by "distinct cross-child boundary pairs" and counted
  // the quotient via the LCA-children `pairReps`. Both UNDERCOUNTED any cut finer than the pair
  // tier: under intermediate tiers (a group with > MAX_FANOUT members), an edge's lowest-relevant
  // pair sits at an INTERMEDIATE proxy, and a cross-subtree edge that is ONE boundary at the coarse
  // tier SPLITS into many leaf↔leaf quotient edges once both subtrees open. The undercount let a
  // cross-subtree explosion slip straight past `hardEdges`. The fix resolves quotient edges from the
  // endpoints' LEAF reps and prices the marginal Δ against the live cut, so the count is exact.

  /** A flat snapshot with `n` leaves under ONE group — large `n` forces intermediate proxy tiers. */
  function tieredOneGroup(n: number): RepresentationHierarchy {
    const directGroupByNode = new Uint32Array(n);
    const snap: CompactGroupingSnapshot = {
      modeKey: "synthetic",
      groupIds: ["g:all"],
      groupLabels: ["all"],
      parentByGroup: Int32Array.from([-1]),
      depthByGroup: Uint16Array.from([0]),
      boxKeyByGroup: ["box:all"],
      directGroupByNode,
      roots: Uint32Array.from([0]),
    };
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    return buildRepresentationHierarchy(snap, ids, { intermediateTiers: true });
  }

  test("intermediate-tiered clique: full refine reports the TRUE quotient (not the undercount)", () => {
    // 64 leaves under one group → the group rep's children are INTERMEDIATE proxies, not leaves.
    // A full clique fully refined is C(64,2) = 2016 visible quotient edges. The old boundary-pair
    // sum reported 993 — this asserts the corrected exact count.
    const n = 64;
    const h = tieredOneGroup(n);
    const idx = buildRepresentationEdgeIndex(h, clique(n));
    const budget = edgeGatedBudget(1_000_000); // edges have ample room → fully refine
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    expect(new Set(cut.selectedRepresentations).size).toBe(n); // every leaf selected
    expect(cut.edgeCost).toBe((n * (n - 1)) / 2); // 2016 — the real quotient, not 993
  });

  test("cross-subtree explosion under tiers is REJECTED by hardEdges (no silent slip-through)", () => {
    // 64-leaf clique under intermediate tiers, edge ceiling 100 < 2016. The solver must STOP short
    // of the explosion and keep the reported edge cost within the finite ceiling — the exact failure
    // mode B2 exists to prevent, which the boundary-pair model (reporting 0/993) let through.
    const n = 64;
    const h = tieredOneGroup(n);
    const idx = buildRepresentationEdgeIndex(h, clique(n));
    const budget = edgeGatedBudget(100);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget, { edgeIndex: idx });
    expect(cut.edgeCost).toBeLessThanOrEqual(budget.hardEdges);
    expect(new Set(cut.selectedRepresentations).size).toBeLessThan(n); // not fully exploded
  });
});
