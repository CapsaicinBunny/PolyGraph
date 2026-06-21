// P0.5 "intermediate-tiers-fallback" probe — design B1 "Nanite-style render-only intermediate
// proxies" + invariants (a)-(d) + impl note (c).
//
// WITHOUT intermediate tiers a flat group with thousands of members parents every leaf DIRECTLY,
// so the ONLY refinement of that group is the atomic reveal of its WHOLE leaf set — which the
// solver's hard budget rejects, stranding the group at one aggregate card FOREVER (design B1 "the
// biggest gap"). The deterministic BALANCED-CHUNK fallback inserts a bounded tree of render-only
// INTERMEDIATE proxies between the group and its leaves, so refinement has bounded intermediate
// antichains to land on. The four invariants below must hold for the ~5000-member synthetic group:
//   (a) the coarsest cut fits hardCards;
//   (b) no rep exceeds MAX_FANOUT children;
//   (c) an oversized group gets intermediate tiers;
//   (d) a one-level refine of a group yields its bounded intermediate children, NOT its leaf set.

import { describe, expect, test } from "bun:test";
import { type CompactGroupingSnapshot, NO_GROUP } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  MAX_FANOUT,
  MAX_LEAVES_PER_PROXY,
  type RepresentationHierarchy,
} from "./representation";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  type LodBudget,
  rootCut,
  solveLodCut,
} from "./lod-cut-solver";

// ── snapshot synthesis: ONE flat group holding `members` nodes ──────────────────────
// A single root group `g0` whose `members` nodes all belong to it (no orphans). This is the
// flat-mode shape the spec calls out: one semantic level, a huge membership, so the group rep
// would directly parent thousands of leaves without intermediate tiering.
function oneGroupSnapshot(members: number) {
  const directGroupByNode = new Uint32Array(members).fill(0);
  const nodeIds = Array.from({ length: members }, (_, i) => `n${i}`);
  const snap: CompactGroupingSnapshot = {
    modeKey: "flat",
    groupIds: ["g0"],
    groupLabels: ["g0"],
    parentByGroup: new Int32Array(1).fill(-1),
    depthByGroup: new Uint16Array(1),
    boxKeyByGroup: ["g0"],
    directGroupByNode,
    roots: Uint32Array.from([0]),
  };
  return { snap, nodeIds };
}

const cam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };
const noConstraints: CutConstraints = { forceClosed: new Set(), forceOpen: new Set() };

/** A budget whose CARDS dimension is the one under test; the rest are huge-but-finite. */
function cardsBudget(hardCards: number, targetCards = hardCards): LodBudget {
  const BIG = 100_000_000;
  return {
    targetCards,
    hardCards,
    targetLayoutCost: BIG,
    hardLayoutCost: BIG,
    targetEdges: BIG,
    hardEdges: BIG,
    targetLabels: BIG,
    hardLabels: BIG,
    maxGpuBytes: BIG,
  };
}

/** The direct children of a rep, via the firstChild/nextSibling links (the solver's own view). */
function childrenOf(h: RepresentationHierarchy, rep: number): number[] {
  const { firstChildByRep, nextSiblingByRep } = h.columns;
  const out: number[] = [];
  let guard = h.repCount + 1;
  for (let c = firstChildByRep[rep]; c !== -1 && guard-- > 0; c = nextSiblingByRep[c]) out.push(c);
  return out;
}

/** True iff a rep is a leaf rep (one per node: ids [groupCount, groupCount + nodeCount)). */
function isLeafRep(h: RepresentationHierarchy, rep: number, members: number): boolean {
  const groupCount = h.snapshot.groupIds.length;
  return rep >= groupCount && rep < groupCount + members;
}

/** Antichain validity (every node's leaf→root path hits EXACTLY one selected rep). */
function antichainViolation(h: RepresentationHierarchy, selected: Set<number>): string | null {
  const { parentByRep, leafRepresentationByNode } = h.columns;
  for (let i = 0; i < leafRepresentationByNode.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = h.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    if (hits !== 1) return `node ${i}: ${hits} selected reps on path (expected 1)`;
  }
  return null;
}

const MEMBERS = 5000;

describe("intermediate tiers OFF (default) — unchanged direct parenting", () => {
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const h = buildRepresentationHierarchy(snap, nodeIds);

  test("no synthetic reps: repCount is groups + nodes", () => {
    expect(h.repCount).toBe(1 + MEMBERS);
  });

  test("the group rep parents ALL 5000 leaves directly (the stuck-at-one-card shape)", () => {
    const groupRep = h.repOfGroup[0];
    expect(childrenOf(h, groupRep).length).toBe(MEMBERS);
    // Its only one-level refinement is the atomic reveal of the whole leaf set — exactly the
    // gap the intermediate tiers fix.
  });
});

describe("intermediate tiers ON — B1 invariants on a ~5000-member group", () => {
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true });
  const groupRep = h.repOfGroup[0];

  test("invariant (a): the coarsest cut fits hardCards", () => {
    // The group is a root; the coarsest cut selects it (one card). Far within any sane budget,
    // and crucially within a tiny one — the bootstrap antichain is feasible.
    const coarsest = rootCut(h);
    expect(coarsest.cardCost).toBe(1);
    const budget = cardsBudget(64);
    expect(coarsest.cardCost).toBeLessThanOrEqual(budget.hardCards);
    // It is still a valid antichain covering every node exactly once.
    expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
  });

  test("invariant (b): no rep exceeds MAX_FANOUT children", () => {
    for (let r = 0; r < h.repCount; r++) {
      expect(childrenOf(h, r).length).toBeLessThanOrEqual(MAX_FANOUT);
    }
  });

  test("invariant (b cont.): no proxy directly stands in for more than MAX_LEAVES_PER_PROXY leaves", () => {
    // A bottom-tier proxy's direct children are leaves; the balanced-chunk size is MAX_FANOUT
    // (≤ MAX_LEAVES_PER_PROXY), so the leaf-per-proxy bound holds for every rep.
    for (let r = 0; r < h.repCount; r++) {
      const directLeaves = childrenOf(h, r).filter((c) => isLeafRep(h, c, MEMBERS));
      expect(directLeaves.length).toBeLessThanOrEqual(MAX_LEAVES_PER_PROXY);
    }
  });

  test("invariant (c): the oversized group received intermediate tiers (synthetic reps appended)", () => {
    // Synthetic render-only proxies exist beyond the base [groups + nodes] range.
    expect(h.repCount).toBeGreaterThan(1 + MEMBERS);
    // The group rep no longer parents the leaves directly; its children are intermediate proxies.
    const kids = childrenOf(h, groupRep);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.length).toBeLessThanOrEqual(MAX_FANOUT);
    for (const c of kids) {
      // Each child of the group is a render-only structural proxy (NO group), not a leaf.
      expect(isLeafRep(h, c, MEMBERS)).toBe(false);
      expect(h.columns.groupByRep[c]).toBe(NO_GROUP);
    }
  });

  test("invariant (d): a one-level refine yields bounded intermediate children, NOT the leaf set", () => {
    // Refining the group proxy reveals its DIRECT children (the top intermediate tier), bounded
    // by MAX_FANOUT — never the 5000-leaf set. This is exactly what lets the solver progress.
    const kids = childrenOf(h, groupRep);
    expect(kids.length).toBeLessThan(MEMBERS); // emphatically not the whole leaf set
    expect(kids.length).toBeLessThanOrEqual(MAX_FANOUT);
    // Selecting the group's children in place of the group is a valid antichain (the refined cut).
    const refined = new Set<number>([...rootCut(h).selectedRepresentations]);
    refined.delete(groupRep);
    for (const c of kids) refined.add(c);
    expect(antichainViolation(h, refined)).toBeNull();
    // And it costs exactly one card per revealed child — a bounded, budget-checkable step.
    expect(refined.size).toBe(kids.length);
  });

  test("costs roll up bottom-up unchanged: the group's subtree node cost is the full membership", () => {
    // Intermediate proxies carry zero leaf cost of their own; the rollup over the deeper tree
    // still sums to 5000 (one per node, default cost 1).
    expect(h.columns.subtreeNodeCost[groupRep]).toBe(MEMBERS);
    // Every intermediate proxy is render-only: one aggregate card, one label, no edges/gpu.
    const base = 1 + MEMBERS;
    for (let r = base; r < h.repCount; r++) {
      expect(h.columns.groupByRep[r]).toBe(NO_GROUP);
      expect(h.columns.nodeCost[r]).toBe(1);
      expect(h.columns.labelCost[r]).toBe(1);
      expect(h.columns.edgeCost[r]).toBe(0);
      expect(h.columns.gpuByteCost[r]).toBe(0);
    }
  });

  test("group/leaf rep ids are byte-identical to a build without tiers (only synthetic tier differs)", () => {
    const plain = buildRepresentationHierarchy(snap, nodeIds);
    const base = 1 + MEMBERS;
    for (let r = 0; r < base; r++) {
      expect(h.columns.groupByRep[r]).toBe(plain.columns.groupByRep[r]);
    }
    expect(h.columns.leafRepresentationByNode).toEqual(plain.columns.leafRepresentationByNode);
    expect(h.repOfGroup).toEqual(plain.repOfGroup);
  });

  test("the solver can progressively refine the group beyond one card (the central B1 promise)", () => {
    // With tiers the solver, given enough budget, refines past the single aggregate card — the
    // thing that is IMPOSSIBLE without intermediate antichains. A modest card budget admits more
    // than one card yet stays within the hard ceiling and a valid antichain.
    const budget = cardsBudget(200, 200);
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget);
    expect(cut.cardCost).toBeGreaterThan(1); // progressed beyond the stuck single card
    expect(cut.cardCost).toBeLessThanOrEqual(budget.hardCards);
    expect(antichainViolation(h, new Set(cut.selectedRepresentations))).toBeNull();
  });
});

describe("intermediate tiers + a deeper recursion (membership ≫ MAX_FANOUT²)", () => {
  // MAX_FANOUT² = 1024 leaves fit in two tiers; 5000 forces a THIRD tier (group → mid → low →
  // leaves). Proves the recursion (not just one tier) and that the top still obeys the bound.
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true });
  const groupRep = h.repOfGroup[0];

  test("more than one intermediate level was built (deep balanced-chunk recursion)", () => {
    // 5000 / 32 = 157 bottom proxies → 157 / 32 = 5 mid proxies → 1 group. So the group's
    // direct children number 5 (≤ MAX_FANOUT) and there are 157 + 5 = 162 synthetic reps.
    expect(childrenOf(h, groupRep).length).toBe(
      Math.ceil(Math.ceil(MEMBERS / MAX_FANOUT) / MAX_FANOUT),
    );
    expect(h.repCount - (1 + MEMBERS)).toBe(
      Math.ceil(MEMBERS / MAX_FANOUT) + Math.ceil(Math.ceil(MEMBERS / MAX_FANOUT) / MAX_FANOUT),
    );
  });

  test("every leaf is still reachable from the group exactly once (deep antichain holds)", () => {
    const coarsest = rootCut(h);
    expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
  });
});

describe("intermediate tiers bound CHILD-GROUP fan-out, not just leaves (invariant b)", () => {
  // A directory-shaped snapshot: one parent group g0 with `subgroups` CHILD GROUPS, each holding
  // a single leaf. g0 has ZERO direct leaves, so leaf-only tiering would see fan-out 0 and insert
  // nothing — yet g0's real fan-out is `subgroups` (its child group reps). Invariant (b) is over
  // CHILD COUNT, so the subgroups must be tiered too.
  function nestedSnapshot(subgroups: number) {
    const groupCount = 1 + subgroups; // g0 + children
    const parentByGroup = new Int32Array(groupCount).fill(-1);
    for (let g = 1; g < groupCount; g++) parentByGroup[g] = 0; // children of g0
    const groupIds = Array.from({ length: groupCount }, (_, i) => `g${i}`);
    const directGroupByNode = new Uint32Array(subgroups);
    const nodeIds: string[] = [];
    for (let i = 0; i < subgroups; i++) {
      directGroupByNode[i] = i + 1; // node i belongs to child group g(i+1)
      nodeIds.push(`n${i}`);
    }
    const snap: CompactGroupingSnapshot = {
      modeKey: "dir",
      groupIds,
      groupLabels: groupIds.slice(),
      parentByGroup,
      depthByGroup: new Uint16Array(groupCount),
      boxKeyByGroup: groupIds.slice(),
      directGroupByNode,
      roots: Uint32Array.from([0]),
    };
    return { snap, nodeIds };
  }

  const SUBGROUPS = 50; // > MAX_FANOUT (32)
  const { snap, nodeIds } = nestedSnapshot(SUBGROUPS);
  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true });

  test("a group with >MAX_FANOUT SUBGROUPS (no direct leaves) is tiered", () => {
    const g0 = h.repOfGroup[0];
    expect(childrenOf(h, g0).length).toBeLessThanOrEqual(MAX_FANOUT);
    // 50 subgroups → ceil(50/32)=2 top-tier proxies under g0.
    expect(childrenOf(h, g0).length).toBe(Math.ceil(SUBGROUPS / MAX_FANOUT));
    // g0's direct children are render-only proxies, not the child groups directly.
    for (const c of childrenOf(h, g0)) expect(h.columns.groupByRep[c]).toBe(NO_GROUP);
  });

  test("no rep exceeds MAX_FANOUT and the antichain still covers every node once", () => {
    for (let r = 0; r < h.repCount; r++) {
      expect(childrenOf(h, r).length).toBeLessThanOrEqual(MAX_FANOUT);
    }
    const coarsest = rootCut(h);
    expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
  });

  test("subtree cost rolls up through the tiered subgroups (one leaf per subgroup)", () => {
    expect(h.columns.subtreeNodeCost[h.repOfGroup[0]]).toBe(SUBGROUPS);
  });

  test("a mixed group (subgroups + direct leaves) bounds the COMBINED fan-out", () => {
    // g0 with 20 child groups AND 20 direct leaves = 40 direct children > MAX_FANOUT, though
    // neither kind alone exceeds it — the classic case leaf-only tiering missed.
    const subgroups = 20;
    const leaves = 20;
    const groupCount = 1 + subgroups;
    const parentByGroup = new Int32Array(groupCount).fill(-1);
    for (let g = 1; g < groupCount; g++) parentByGroup[g] = 0;
    const groupIds = Array.from({ length: groupCount }, (_, i) => `g${i}`);
    // nodes 0..19 belong to child groups g1..g20; nodes 20..39 belong DIRECTLY to g0.
    const directGroupByNode = new Uint32Array(subgroups + leaves);
    const ids: string[] = [];
    for (let i = 0; i < subgroups; i++) {
      directGroupByNode[i] = i + 1;
      ids.push(`s${i}`);
    }
    for (let i = 0; i < leaves; i++) {
      directGroupByNode[subgroups + i] = 0;
      ids.push(`l${i}`);
    }
    const mixed: CompactGroupingSnapshot = {
      modeKey: "dir",
      groupIds,
      groupLabels: groupIds.slice(),
      parentByGroup,
      depthByGroup: new Uint16Array(groupCount),
      boxKeyByGroup: groupIds.slice(),
      directGroupByNode,
      roots: Uint32Array.from([0]),
    };
    const hm = buildRepresentationHierarchy(mixed, ids, { intermediateTiers: true });
    expect(childrenOf(hm, hm.repOfGroup[0]).length).toBeLessThanOrEqual(MAX_FANOUT);
    const coarsest = rootCut(hm);
    expect(antichainViolation(hm, new Set(coarsest.selectedRepresentations))).toBeNull();
    expect(hm.columns.subtreeNodeCost[hm.repOfGroup[0]]).toBe(subgroups + leaves);
  });
});

describe("intermediate tiers compose with bootstrap normalization", () => {
  // Both options on: the root group still gets adopted by a super-root (bootstrap), AND its
  // 5000 leaves still get intermediate tiers below it. The two synthetic tiers coexist.
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const h = buildRepresentationHierarchy(snap, nodeIds, {
    intermediateTiers: true,
    bootstrapRoots: true,
  });

  test("super-root is the sole root and the coarsest cut is one card", () => {
    expect(h.roots).toEqual([h.superRoot]);
    expect(rootCut(h).cardCost).toBe(1);
  });

  test("no rep exceeds MAX_FANOUT children with BOTH normalizations active", () => {
    for (let r = 0; r < h.repCount; r++) {
      expect(childrenOf(h, r).length).toBeLessThanOrEqual(MAX_FANOUT);
    }
  });

  test("every node is represented exactly once at the coarsest cut", () => {
    const coarsest = rootCut(h);
    expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
  });
});
