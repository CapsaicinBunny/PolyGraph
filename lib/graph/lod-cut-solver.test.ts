import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot, type CompactGroupingSnapshot } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  type RepresentationCosts,
  type RepresentationHierarchy,
} from "./representation";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  cutSignature,
  cutSignaturesEqual,
  type LimitedDetail,
  LOD_BUDGET,
  type LodBudget,
  type LodCut,
  makeRuntimeCut,
  rootCut,
  selectedRepresentationsHash,
  type SolveDiagnostics,
  solveLodCut,
} from "./lod-cut-solver";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/y/f3.c"),
    file("b/z/f4.c"),
    file("b/z/f5.c"),
    file("b/z/f6.c"),
    file("top.c"),
  ],
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const h = buildRepresentationHierarchy(snap, nodeIds);

function groupRep(hh: RepresentationHierarchy, id: string): number {
  const ord = hh.snapshot.groupIds.indexOf(id);
  if (ord === -1) throw new Error(`no group ${id}`);
  return hh.repOfGroup[ord];
}
function leafRep(hh: RepresentationHierarchy, nodeId: string): number {
  return hh.columns.leafRepresentationByNode[nodeIds.indexOf(nodeId)];
}

const noConstraints: CutConstraints = { forceClosed: new Set(), forceOpen: new Set() };
const cam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };

// Test fixtures use nodeCost 1 per leaf, so layout == cards; layout/edge/label/gpu ceilings
// are set high-but-FINITE so the CARDS dimension is the binding one under test (Gap 6: every
// ceiling is finite — no Infinity/totalNodes).
/** A generous budget that lets the solver refine everything to leaves. */
const bigBudget: LodBudget = {
  targetCards: 1000,
  hardCards: 10000,
  targetLayoutCost: 1_000_000,
  hardLayoutCost: 1_000_000,
  targetEdges: 1000,
  hardEdges: 10000,
  targetLabels: 1000,
  hardLabels: 10000,
  maxGpuBytes: 1_000_000_000,
};
/** A tiny soft budget: auto refinement is heavily constrained. */
const tinyBudget: LodBudget = {
  targetCards: 2,
  hardCards: 4,
  targetLayoutCost: 1_000_000,
  hardLayoutCost: 1_000_000,
  targetEdges: 1000,
  hardEdges: 10000,
  targetLabels: 1000,
  hardLabels: 10000,
  maxGpuBytes: 1_000_000_000,
};

/** Assert the cut is a VALID ANTICHAIN: every node represented exactly once. */
function assertValidAntichain(hh: RepresentationHierarchy, cut: LodCut) {
  const selected = new Set(cut.selectedRepresentations);
  // every node maps to exactly one selected rep on its leaf→root path
  const { parentByRep, leafRepresentationByNode } = hh.columns;
  for (let i = 0; i < nodeIds.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = hh.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    expect(hits).toBe(1); // exactly once: never 0 (unrepresented), never 2 (proxy+child)
  }
}

describe("solveLodCut — produces a valid antichain", () => {
  test("the root cut covers every node exactly once", () => {
    const cut = rootCut(h);
    assertValidAntichain(h, cut);
  });

  test("refined to leaves under a big budget — still a valid antichain", () => {
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    assertValidAntichain(h, cut);
  });

  test("a tiny soft budget keeps the cut coarse but valid", () => {
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, tinyBudget);
    assertValidAntichain(h, cut);
    // auto must not exceed the SOFT node target… but the floor is the coarsest cut
    // (roots), which may already exceed target — so it never exceeds the HARD ceiling.
    expect(cut.cardCost).toBeLessThanOrEqual(tinyBudget.hardCards);
  });
});

describe("solveLodCut — forceClosed / forceOpen constraints (Appendix A §A)", () => {
  test("forceClosed selects the requested proxy and excludes its descendants", () => {
    const a = groupRep(h, "directory:a");
    const c: CutConstraints = { forceClosed: new Set([a]), forceOpen: new Set() };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, bigBudget);
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(a)).toBe(true);
    // no descendant of a is selected (a stands in for its whole subtree)
    expect(selected.has(groupRep(h, "directory:a/x"))).toBe(false);
    expect(selected.has(leafRep(h, "a/x/f1.c"))).toBe(false);
    assertValidAntichain(h, cut);
  });

  test("forceOpen forbids a proxy standing in — the solver descends ≥1 level", () => {
    const a = groupRep(h, "directory:a");
    // With no budget pressure the natural cut might select `a`; force it open.
    const closedElsewhere: CutConstraints = {
      forceClosed: new Set([a]),
      forceOpen: new Set(),
    };
    const closed = solveLodCut(h, bootstrapCut(h), closedElsewhere, cam, tinyBudget);
    expect(new Set(closed.selectedRepresentations).has(a)).toBe(true); // baseline: a is the proxy

    const c: CutConstraints = { forceClosed: new Set(), forceOpen: new Set([a]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, tinyBudget);
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(a)).toBe(false); // a may NOT be the representative
    // its subtree is now represented by descendants (a/x and a/y, or deeper)
    assertValidAntichain(h, cut);
  });

  test("parent-closed wins over a descendant-open (precedence)", () => {
    const a = groupRep(h, "directory:a");
    const ax = groupRep(h, "directory:a/x");
    const c: CutConstraints = { forceClosed: new Set([a]), forceOpen: new Set([ax]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, bigBudget);
    const selected = new Set(cut.selectedRepresentations);
    expect(selected.has(a)).toBe(true); // parent-closed wins
    expect(selected.has(ax)).toBe(false);
    assertValidAntichain(h, cut);
  });

  // Regression — the running cost vector `cur` must NOT go stale after the forceClosed
  // phase. forceClosedRep mutates `selected` (drops opened descendants, adds the proxy)
  // WITHOUT decrementing `cur`; if `cur` is left stale, refineUnderBudget sees the budget
  // as more spent than it is and UNDER-refines after a close-over-an-open. Here forceOpen
  // b/z first drives cost up (b → b/z → f4,f5,f6), then forceClose b collapses it back to a
  // single `b` card — the real cost drops, so the remaining budget must let `a` refine to
  // the target. (Pre-fix: the cut stayed coarse at {a, b, top} = 3, never refining a.)
  test("cur is recomputed after forceClosed — refines to budget after a close-over-an-open", () => {
    const a = groupRep(h, "directory:a");
    const b = groupRep(h, "directory:b");
    const bz = groupRep(h, "directory:b/z");
    // target 4: root {a, b, top} = 3 leaves room for ONE more refine (a → a/x, a/y = 4).
    const targetFour: LodBudget = { ...tinyBudget, targetCards: 4, hardCards: 100 };
    const c: CutConstraints = { forceOpen: new Set([bz]), forceClosed: new Set([b]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, targetFour);
    assertValidAntichain(h, cut);
    const selected = new Set(cut.selectedRepresentations);
    // b is closed (its subtree collapsed to the proxy), freeing budget for a to refine.
    expect(selected.has(b)).toBe(true);
    expect(selected.has(bz)).toBe(false);
    // The freed budget refines a to the target — NOT left coarse by a stale cost vector.
    expect(cut.cardCost).toBe(4);
    expect(selected.has(a)).toBe(false); // a was refined into its children
    expect(selected.has(groupRep(h, "directory:a/x"))).toBe(true);
    // Identical outcome to closing b WITHOUT the prior open — proving the open left no
    // residue in the cost vector.
    const closeOnly = solveLodCut(
      h,
      bootstrapCut(h),
      { forceOpen: new Set(), forceClosed: new Set([b]) },
      cam,
      targetFour,
    );
    expect([...cut.selectedRepresentations]).toEqual([...closeOnly.selectedRepresentations]);
  });
});

describe("solveLodCut — user-open may exceed soft but never hard (Appendix A §B)", () => {
  test("a forced open exceeds the soft target up to the hard ceiling", () => {
    // Soft target = 1 node; auto would stay at roots. Force-open every root group so the
    // whole graph must refine — exceeding soft, bounded by hard.
    const softOne: LodBudget = { ...tinyBudget, targetCards: 1, hardCards: 1000 };
    const a = groupRep(h, "directory:a");
    const b = groupRep(h, "directory:b");
    const c: CutConstraints = { forceClosed: new Set(), forceOpen: new Set([a, b]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, softOne);
    assertValidAntichain(h, cut);
    expect(cut.cardCost).toBeGreaterThan(softOne.targetCards); // exceeded soft
    expect(cut.cardCost).toBeLessThanOrEqual(softOne.hardCards); // within hard
  });

  test("a forced open that would breach the HARD ceiling retains the nearest legal proxy", () => {
    // Root cut = {a, b, top} = 3 cards. hardCards = 4 holds that and ONE refine of a
    // (→ a/x, a/y, b, top = 4) but NOT a full open of a (a/x→f1,f2 would be 5 > 4). So a
    // is opened to its child proxies but a/x and a/y are retained — the deepest safe rep.
    const hardFour: LodBudget = {
      ...tinyBudget,
      targetCards: 1,
      hardCards: 4,
    };
    const a = groupRep(h, "directory:a");
    const c: CutConstraints = { forceClosed: new Set(), forceOpen: new Set([a]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, hardFour);
    assertValidAntichain(h, cut);
    expect(cut.cardCost).toBeLessThanOrEqual(hardFour.hardCards);
    expect(new Set(cut.selectedRepresentations).has(a)).toBe(false); // a IS opened
    // a/x and a/y are retained as proxies (couldn't fully open within hard).
    expect(new Set(cut.selectedRepresentations).has(groupRep(h, "directory:a/x"))).toBe(true);
  });
});

describe("LodBudget — finite split budget model (Gap 6 / 'Finite budget model')", () => {
  test("LOD_BUDGET ships finite ceilings on EVERY dimension (no Infinity)", () => {
    for (const v of [
      LOD_BUDGET.targetCards,
      LOD_BUDGET.hardCards,
      LOD_BUDGET.targetLayoutCost,
      LOD_BUDGET.hardLayoutCost,
      LOD_BUDGET.targetEdges,
      LOD_BUDGET.hardEdges,
      LOD_BUDGET.targetLabels,
      LOD_BUDGET.hardLabels,
      LOD_BUDGET.maxGpuBytes,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // Soft ≤ hard on every split dimension.
    expect(LOD_BUDGET.targetCards).toBeLessThanOrEqual(LOD_BUDGET.hardCards);
    expect(LOD_BUDGET.targetLayoutCost).toBeLessThanOrEqual(LOD_BUDGET.hardLayoutCost);
    expect(LOD_BUDGET.targetEdges).toBeLessThanOrEqual(LOD_BUDGET.hardEdges);
    expect(LOD_BUDGET.targetLabels).toBeLessThanOrEqual(LOD_BUDGET.hardLabels);
  });

  test("cards and layout are DISTINCT: a layout-heavy refine is capped by hardLayoutCost while cards has room", () => {
    // Give every leaf a large nodeCost (1 + symbols = 100) so opening `a` (3 leaves) costs
    // 300 LAYOUT but only +2 CARDS. A generous card budget but a tight layout budget must
    // stop the refine on the LAYOUT dimension — proving the two are not conflated.
    const heavy = buildRepresentationHierarchy(snap, nodeIds, { nodeCost: () => 100 });
    const a = groupRep(heavy, "directory:a");
    const budget: LodBudget = {
      ...LOD_BUDGET,
      targetCards: 1000, // plenty of card room
      hardCards: 1000,
      targetLayoutCost: 150, // but only ~150 layout work — one a/x or a/y refine, not all
      hardLayoutCost: 150,
    };
    const cut = solveLodCut(
      heavy,
      bootstrapCut(heavy),
      { forceClosed: new Set(), forceOpen: new Set([a]) },
      cam,
      budget,
    );
    assertValidAntichain(heavy, cut);
    // Layout never busts its finite ceiling even under a forced open…
    expect(cut.layoutCost).toBeLessThanOrEqual(budget.hardLayoutCost);
    // …while cards stayed well under its (much larger) ceiling — the dimensions are independent.
    expect(cut.cardCost).toBeLessThan(budget.hardCards);
  });

  test("a forced open beyond hardCards is CAPPED and surfaces a 'Detail limited' signal", () => {
    // b/z holds {f4,f5,f6}. Force-open b/z with hardCards too small to hold its 3 leaves.
    // Root {a,b,top}=3. b→b/z keeps 3 cards. hardCards=3 forbids b/z→3 leaves (would be 5).
    // So b opens to b/z, b/z is RETAINED, and a LimitedDetail names the limiting budget.
    const bz = groupRep(h, "directory:b/z");
    const budget: LodBudget = {
      ...LOD_BUDGET,
      targetCards: 1,
      hardCards: 3,
      targetLayoutCost: 1_000_000,
      hardLayoutCost: 1_000_000,
    };
    const diag: SolveDiagnostics = { whyNotRefined: new Map(), refinements: 0, limited: [] };
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([bz]) },
      cam,
      budget,
      { diagnostics: diag },
    );
    assertValidAntichain(h, cut);
    // Capped at the FINITE hard ceiling — never expanded to the whole graph.
    expect(cut.cardCost).toBeLessThanOrEqual(budget.hardCards);
    // b/z is retained as the nearest proxy (its leaves were not revealed).
    expect(new Set(cut.selectedRepresentations).has(bz)).toBe(true);
    // The structured "Detail limited" signal is emitted, naming the cards ceiling.
    expect(diag.limited.length).toBeGreaterThan(0);
    const limit = diag.limited.find((l: LimitedDetail) => l.requestedRep === bz);
    expect(limit).toBeDefined();
    expect(limit?.resolvedRep).toBe(bz);
    expect(limit?.limitingBudget).toBe("cards");
  });

  test("a forced open that FITS within hardCards emits no 'Detail limited' signal", () => {
    const bz = groupRep(h, "directory:b/z");
    const budget: LodBudget = { ...LOD_BUDGET, targetCards: 1, hardCards: 1000 };
    const diag: SolveDiagnostics = { whyNotRefined: new Map(), refinements: 0, limited: [] };
    solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([bz]) },
      cam,
      budget,
      { diagnostics: diag },
    );
    expect(diag.limited.length).toBe(0);
  });
});

describe("solveLodCut — atomic refine/coarsen, byte-identical reject (Appendix A §E)", () => {
  test("a rejected refinement leaves the prior cut byte-identical", () => {
    // hardCards below even the coarsest refine: the solver can make no progress, so the
    // result equals the seed cut exactly (same selected reps, same order).
    const a = groupRep(h, "directory:a");
    const seed = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set([a, groupRep(h, "directory:b")]), forceOpen: new Set() },
      cam,
      tinyBudget,
    );
    // Now solve again from `seed` with a budget that forbids any refinement.
    const noRefine: LodBudget = { ...tinyBudget, targetCards: 0, hardCards: 0 };
    const again = solveLodCut(h, seed, noConstraints, cam, noRefine);
    // The seed's two proxies already cost > 0; with hardCards 0 nothing can change, and a
    // valid cut must still cover everything — so it must return the seed unchanged.
    expect([...again.selectedRepresentations]).toEqual([...seed.selectedRepresentations]);
  });

  test("refine is atomic: a parent is never both present with and replaced by its children", () => {
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const selected = new Set(cut.selectedRepresentations);
    // For every selected rep, none of its ancestors is also selected (antichain ⇒ atomic).
    const { parentByRep } = h.columns;
    for (const r of selected) {
      let p = parentByRep[r];
      while (p !== -1) {
        expect(selected.has(p)).toBe(false);
        p = parentByRep[p];
      }
    }
  });
});

describe("solveLodCut — canonical selectedRepresentations ordering (Appendix A §J/K)", () => {
  test("selectedRepresentations is sorted ascending (equal cuts compare equal)", () => {
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const arr = [...cut.selectedRepresentations];
    expect(arr).toEqual([...arr].sort((x, y) => x - y));
  });

  test("two solves of the same inputs yield byte-identical selectedRepresentations", () => {
    const c1 = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const c2 = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    expect([...c1.selectedRepresentations]).toEqual([...c2.selectedRepresentations]);
  });
});

describe("makeRuntimeCut — O(1) membership via epoch map (Appendix A §J)", () => {
  test("isSelected matches the selected set without scanning", () => {
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const rt = makeRuntimeCut(cut, h.repCount);
    const selected = new Set(cut.selectedRepresentations);
    for (let r = 0; r < h.repCount; r++) {
      expect(rt.isSelected(r)).toBe(selected.has(r));
    }
  });

  test("a fresh runtime cut for a different selection doesn't leak the old epoch", () => {
    const c1 = rootCut(h);
    const c2 = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const rt1 = makeRuntimeCut(c1, h.repCount);
    const rt2 = makeRuntimeCut(c2, h.repCount);
    // rt2 selects leaves; rt1 selects roots — they must not agree on a leaf rep.
    const aLeaf = leafRep(h, "a/x/f1.c");
    expect(rt2.isSelected(aLeaf)).toBe(true);
    expect(rt1.isSelected(aLeaf)).toBe(false);
  });
});

describe("cutSignature — material equality (Appendix A §K)", () => {
  test("equal cuts hash equal; different cuts hash differently", () => {
    const fine = solveLodCut(h, bootstrapCut(h), noConstraints, cam, bigBudget);
    const coarse = rootCut(h);
    expect(selectedRepresentationsHash(fine)).toBe(selectedRepresentationsHash(fine));
    expect(selectedRepresentationsHash(fine)).not.toBe(selectedRepresentationsHash(coarse));
  });

  test("same nodes but a different edge/label stage is NOT materially equal", () => {
    const cut = rootCut(h);
    const s0 = cutSignature(cut, 0, 0, "f1");
    const sameNodesDifferentEdges = cutSignature(cut, 1, 0, "f1");
    const sameNodesDifferentLabels = cutSignature(cut, 0, 1, "f1");
    const differentFilter = cutSignature(cut, 0, 0, "f2");
    expect(cutSignaturesEqual(s0, cutSignature(cut, 0, 0, "f1"))).toBe(true);
    expect(cutSignaturesEqual(s0, sameNodesDifferentEdges)).toBe(false);
    expect(cutSignaturesEqual(s0, sameNodesDifferentLabels)).toBe(false);
    expect(cutSignaturesEqual(s0, differentFilter)).toBe(false);
  });
});

// ── Gap 5 / review #1: marginal refinement cost + continue-after-oversized ───────
//
// A synthetic FLAT hierarchy with two root group proxies of very different fan-out:
// "small" has 2 leaf children, "big" has ~2000. Every proxy renders as ONE card
// (nodeCost 1), so the OLD refinePriority (parent's own per-level cost) saw both as
// equally cheap to refine. The marginal delta (Σ children − parent) separates them:
// refining small adds ~2 cards, refining big adds ~2000.

/** Build a flat snapshot: two root groups "small" (smallN nodes) and "big" (bigN). */
function flatTwoGroupSnapshot(smallN: number, bigN: number): CompactGroupingSnapshot {
  const groupIds = ["g:small", "g:big"];
  const directGroupByNode = new Uint32Array(smallN + bigN);
  for (let i = 0; i < smallN; i++) directGroupByNode[i] = 0; // small
  for (let i = 0; i < bigN; i++) directGroupByNode[smallN + i] = 1; // big
  return {
    modeKey: "synthetic",
    groupIds,
    groupLabels: ["small", "big"],
    parentByGroup: Int32Array.from([-1, -1]), // both roots
    depthByGroup: Uint16Array.from([0, 0]),
    boxKeyByGroup: ["box:small", "box:big"],
    directGroupByNode,
    roots: Uint32Array.from([0, 1]),
  };
}

function buildFlatHierarchy(
  smallN: number,
  bigN: number,
  costs?: RepresentationCosts,
): RepresentationHierarchy {
  const ids = [
    ...Array.from({ length: smallN }, (_, i) => `s${i}`),
    ...Array.from({ length: bigN }, (_, i) => `b${i}`),
  ];
  return buildRepresentationHierarchy(flatTwoGroupSnapshot(smallN, bigN), ids, costs);
}

/** Antichain check parameterized by node count (the module helper hardcodes `nodeIds`). */
function assertAntichainN(hh: RepresentationHierarchy, cut: LodCut, nodeCount: number) {
  const selected = new Set(cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = hh.columns;
  for (let i = 0; i < nodeCount; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = hh.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    expect(hits).toBe(1);
  }
}

describe("refinePriority — ranks by MARGINAL child-expansion delta (Gap 5)", () => {
  test("a 2-child proxy outranks a ~2000-child proxy when budget can't fit both", () => {
    const smallN = 2;
    const bigN = 2000;
    const hh = buildFlatHierarchy(smallN, bigN);
    const smallRep = hh.repOfGroup[0];
    const bigRep = hh.repOfGroup[1];

    // Root cut = {small, big} = 2 cards. A target that leaves room to open ONLY the
    // small proxy (2 cards → 2 leaves: total 1 big + 2 small = 3) but NOT the big proxy
    // (would be ~2001 cards). The marginal-cost ranking must pick `small` to refine.
    // CARDS is the gating dimension; layout (== cards here, nodeCost 1) is held high-finite.
    const budget: LodBudget = {
      targetCards: 4,
      hardCards: 4,
      targetLayoutCost: 1_000_000,
      hardLayoutCost: 1_000_000,
      targetEdges: 100000,
      hardEdges: 100000,
      targetLabels: 100000,
      hardLabels: 100000,
      maxGpuBytes: 1_000_000_000,
    };
    const cut = solveLodCut(hh, bootstrapCut(hh), noConstraints, cam, budget);
    const selected = new Set(cut.selectedRepresentations);

    // small was refined (its 2 leaves now selected), big retained as the single proxy.
    expect(selected.has(smallRep)).toBe(false);
    expect(selected.has(bigRep)).toBe(true);
    // Cost: 2 small leaves + 1 big proxy = 3 cards (within the target-4 budget).
    expect(cut.cardCost).toBe(smallN + 1);
  });

  test("the small proxy's marginal delta is far smaller than the big proxy's", () => {
    // A direct sanity check that the two proxies are NOT seen as equally cheap: refining
    // small adds (smallN − 1) cards, big adds (bigN − 1). With the OLD parent-cost
    // priority both deltas were 1 (nodeCost of a proxy is 1) and the solver would pick by
    // error alone — wrongly opening the big proxy first under tight budget.
    const hh = buildFlatHierarchy(2, 50);
    const smallRep = hh.repOfGroup[0];
    const bigRep = hh.repOfGroup[1];
    const { nodeCost, firstChildByRep, nextSiblingByRep } = hh.columns;
    const marginal = (rep: number) => {
      let sum = 0;
      for (let c = firstChildByRep[rep]; c !== -1; c = nextSiblingByRep[c]) sum += nodeCost[c];
      return sum - nodeCost[rep];
    };
    expect(marginal(smallRep)).toBe(1); // 2 − 1
    expect(marginal(bigRep)).toBe(49); // 50 − 1
  });
});

describe("refineUnderBudget — continue past an oversized candidate (Gap 5)", () => {
  test("budget is filled by smaller refinements when the top candidate doesn't fit", () => {
    // "big" has the highest ERROR (largest subtree → largest geometricError), so it is the
    // highest-priority candidate on the FIRST pass once normalized cost is comparable. But
    // it cannot fit the soft budget. The old code BROKE the loop here, leaving the small
    // proxy unrefined and the budget stranded. With `blocked.add(best); continue;`, the
    // solver moves on and refines `small`, filling the available budget.
    const smallN = 5;
    const bigN = 2000;
    const hh = buildFlatHierarchy(smallN, bigN);
    const smallRep = hh.repOfGroup[0];
    const bigRep = hh.repOfGroup[1];

    // Root = {small, big} = 2. Budget room for the small open (→ 5 leaves + big = 6) but
    // never the big open (~2001). Set target so big does NOT fit but small DOES.
    const budget: LodBudget = {
      targetCards: 10,
      hardCards: 10,
      targetLayoutCost: 1_000_000,
      hardLayoutCost: 1_000_000,
      targetEdges: 100000,
      hardEdges: 100000,
      targetLabels: 100000,
      hardLabels: 100000,
      maxGpuBytes: 1_000_000_000,
    };
    const cut = solveLodCut(hh, bootstrapCut(hh), noConstraints, cam, budget);
    const selected = new Set(cut.selectedRepresentations);

    // The small proxy WAS refined despite big being rejected first — budget not stranded.
    expect(selected.has(smallRep)).toBe(false);
    expect(selected.has(bigRep)).toBe(true);
    expect(cut.cardCost).toBe(smallN + 1); // 5 small leaves + 1 big proxy = 6
    assertAntichainN(hh, cut, smallN + bigN);
  });

  // The test above does NOT actually exercise the blocked.add(best);continue; branch:
  // with marginal-cost ranking the *small* proxy has the higher priority (its tiny delta
  // normalizes cheap), so the solver picks small FIRST and never selects big as `best`.
  // break vs continue produce the identical cut there. To genuinely discriminate the fix
  // the OVERSIZED candidate must be the highest-priority one — engineered here by loading
  // big's leaves with edge cost so big's structuralError (hence deltaError) dwarfs small's,
  // out-ranking it despite a worse normalized cost. With `break` the solver stops at the
  // unfittable big and strands the budget (small never refines); with `continue` it skips
  // big and refines small. This test FAILS on the pre-fix `break`.
  test("the highest-priority candidate being oversized does not strand the budget", () => {
    const smallN = 2;
    const bigN = 5;
    // Edge cost only on big's leaves (`b*`) → big proxy carries large structuralError, so
    // its deltaError (geometric × (1 + structural)) is far higher than small's.
    const hh = buildFlatHierarchy(smallN, bigN, {
      edgeCost: (id) => (id.startsWith("b") ? 50 : 0),
    });
    const smallRep = hh.repOfGroup[0];
    const bigRep = hh.repOfGroup[1];

    // Root = {small, big} = 2. target 5 → remaining 3 cards. big's card delta is 4
    // (5 children − 1 proxy) > 3 → does NOT fit. small's delta is 1 → fits. Edges/labels/
    // layout budgets are huge-finite so only the CARDS dimension gates.
    const budget: LodBudget = {
      targetCards: 5,
      hardCards: 5,
      targetLayoutCost: 1_000_000,
      hardLayoutCost: 1_000_000,
      targetEdges: 1e9,
      hardEdges: 1e9,
      targetLabels: 1e9,
      hardLabels: 1e9,
      maxGpuBytes: 1_000_000_000,
    };
    // Sanity: big is genuinely the higher-priority candidate on the first pass (it would be
    // tried, and rejected, before small) — otherwise this wouldn't test continue-vs-break.
    expect(hh.columns.structuralError[bigRep]).toBeGreaterThan(0);
    expect(hh.columns.structuralError[smallRep]).toBe(0);

    const cut = solveLodCut(hh, bootstrapCut(hh), noConstraints, cam, budget);
    const selected = new Set(cut.selectedRepresentations);

    // Despite big being the top priority and unfittable, small was still refined.
    expect(selected.has(smallRep)).toBe(false);
    expect(selected.has(bigRep)).toBe(true);
    expect(cut.cardCost).toBe(smallN + 1); // 2 small leaves + 1 big proxy = 3
    assertAntichainN(hh, cut, smallN + bigN);
  });
});
