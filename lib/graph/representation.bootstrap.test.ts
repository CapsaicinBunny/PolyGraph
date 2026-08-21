// P0.5 "super-root-bootstrap" probe — design B1 "Bootstrap feasibility" + impl note (c).
//
// WITHOUT bootstrap normalization, NO_GROUP orphan leaves AND group roots each become an
// independent root (parentByRep -1), and rootCut selects EVERY root — so a graph with many
// orphans starts the coarsest antichain OVER budget, and (since refinement only ADDS cards)
// it can never become feasible. The synthetic super-root / root-bucket tier adopts the
// natural roots so the coarsest cut is one card — always within hardCards — while obeying
// MAX_FANOUT (no unbounded fan-out) and tiering deep root sets.

import { describe, expect, test } from "bun:test";
import { type CompactGroupingSnapshot, NO_GROUP } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  MAX_FANOUT,
  representationBuilderVersion,
  type RepresentationHierarchy,
  representativeOf,
} from "./representation";
import {
  bootstrapCut,
  type CutConstraints,
  type LodBudget,
  type CameraState,
  rootCut,
  makeRuntimeCut,
  solveLodCut,
} from "./lod-cut-solver";

// ── snapshot synthesis: a flat grouping with a controllable orphan count ───────────
// `groupCount` flat root groups, `nodeCount` nodes, the first `orphans` of which are
// NO_GROUP and the rest spread across the groups. Mirrors the flat-mode / high-orphan
// shape the spec calls out (Package / community / synthetic-None bootstrap).
function flatSnapshot(groupCount: number, nodeCount: number, orphans: number) {
  const groupIds = Array.from({ length: groupCount }, (_, g) => `g${g}`);
  const directGroupByNode = new Uint32Array(nodeCount);
  const nodeIds: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodeIds.push(`n${i}`);
    directGroupByNode[i] = i < orphans || groupCount === 0 ? NO_GROUP : i % groupCount;
  }
  const snap: CompactGroupingSnapshot = {
    modeKey: "flat",
    groupIds,
    groupLabels: groupIds.slice(),
    parentByGroup: new Int32Array(groupCount).fill(-1), // flat: every group is a root
    depthByGroup: new Uint16Array(groupCount),
    boxKeyByGroup: groupIds.slice(),
    directGroupByNode,
    roots: Uint32Array.from({ length: groupCount }, (_, g) => g),
  };
  return { snap, nodeIds };
}

const cam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };
const noConstraints: CutConstraints = { forceClosed: new Set(), forceOpen: new Set() };

/** A budget whose CARDS dimension is the one under test; the rest are huge-but-finite. */
function cardsBudget(hardCards: number, targetCards = hardCards): LodBudget {
  const BIG = 1_000_000;
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

describe("bootstrap normalization OFF (default) — unchanged", () => {
  const { snap, nodeIds } = flatSnapshot(3, 40, 30); // 30 orphans + 3 groups
  const h = buildRepresentationHierarchy(snap, nodeIds);

  test("no synthetic reps: repCount is groups + nodes, superRoot -1", () => {
    expect(h.repCount).toBe(3 + 40);
    expect(h.superRoot).toBe(-1);
  });

  test("every orphan leaf and group root is its own root (the over-budget bootstrap)", () => {
    // 30 orphan leaves + 3 group roots = 33 roots — rootCut would select all 33.
    expect(h.roots.length).toBe(30 + 3);
  });
});

describe("bootstrap normalization ON — B1 feasibility", () => {
  test("a many-orphan graph yields a budget-feasible bootstrap antichain (coarsest cut ≤ hardCards)", () => {
    // 500 orphans + 8 groups → 508 natural roots. The UN-normalized coarsest cut is 508
    // cards, far over a 2000 hard budget IF it scaled — but the real failure is the spec's:
    // a graph with enough orphans (say hardCards=64) is unsolvable. Prove normalization caps it.
    const { snap, nodeIds } = flatSnapshot(8, 508, 500);
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });

    // Exactly one root (the super-root) → coarsest cut is ONE card.
    expect(h.roots).toEqual([h.superRoot]);
    expect(h.superRoot).toBeGreaterThanOrEqual(0);

    const coarsest = rootCut(h);
    expect(coarsest.cardCost).toBe(1);

    // The whole point: even a tiny hard budget admits the bootstrap antichain.
    const budget = cardsBudget(64);
    expect(coarsest.cardCost).toBeLessThanOrEqual(budget.hardCards);

    // And the seeded solve stays within hard and remains a valid antichain.
    const cut = solveLodCut(h, bootstrapCut(h), noConstraints, cam, budget);
    expect(cut.cardCost).toBeLessThanOrEqual(budget.hardCards);
    expect(antichainViolation(h, new Set(cut.selectedRepresentations))).toBeNull();
  });

  test("the bootstrap antichain covers every node exactly once (super-root represents all)", () => {
    const { snap, nodeIds } = flatSnapshot(4, 100, 60);
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    const coarsest = rootCut(h);
    expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
    // representativeOf resolves every node to the super-root at the coarsest cut.
    const rt = makeRuntimeCut(coarsest, h.repCount);
    for (let i = 0; i < nodeIds.length; i++) {
      expect(representativeOf(h, i, rt.isSelected)).toBe(h.superRoot);
    }
  });

  test("no rep exceeds MAX_FANOUT children (invariant b) even with thousands of orphans", () => {
    const { snap, nodeIds } = flatSnapshot(0, 5000, 5000); // 5000 pure orphans
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    const { firstChildByRep, nextSiblingByRep } = h.columns;
    for (let r = 0; r < h.repCount; r++) {
      let n = 0;
      for (let c = firstChildByRep[r]; c !== -1; c = nextSiblingByRep[c]) n++;
      expect(n).toBeLessThanOrEqual(MAX_FANOUT);
    }
    // 5000 orphans / 32 ≈ 157 buckets → at least one intermediate tier above the leaves,
    // then a super-root: more than one synthetic level was built.
    expect(h.repCount).toBeGreaterThan(5000); // synthetic reps appended
    expect(h.roots).toEqual([h.superRoot]);
  });

  test("group roots AND orphan leaves are BOTH adopted (mixed bootstrap)", () => {
    const { snap, nodeIds } = flatSnapshot(5, 50, 20); // 5 group roots + 20 orphan leaves
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    const { parentByRep, leafRepresentationByNode } = h.columns;
    // A group root now has a synthetic (≥ base) parent, not -1.
    for (let g = 0; g < 5; g++) expect(parentByRep[g]).toBeGreaterThanOrEqual(5 + 50);
    // An orphan leaf (n0, NO_GROUP) likewise.
    const orphanLeaf = leafRepresentationByNode[0];
    expect(parentByRep[orphanLeaf]).toBeGreaterThanOrEqual(5 + 50);
    // The cut is valid and feasible at a small budget.
    const cut = rootCut(h);
    expect(antichainViolation(h, new Set(cut.selectedRepresentations))).toBeNull();
    expect(cut.cardCost).toBe(1);
  });

  test("synthetic buckets carry NO group and a render-only single-card cost", () => {
    // 0 orphans → all 200 nodes belong to the 2 groups (no empty group reps to count).
    const { snap, nodeIds } = flatSnapshot(2, 200, 0);
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    const base = h.snapshot.groupIds.length + nodeIds.length;
    for (let r = base; r < h.repCount; r++) {
      expect(h.columns.groupByRep[r]).toBe(NO_GROUP); // structural proxy — no semantic group
      expect(h.columns.nodeCost[r]).toBe(1); // one aggregate card
      expect(h.columns.labelCost[r]).toBe(1);
      expect(h.columns.edgeCost[r]).toBe(0);
      expect(h.columns.gpuByteCost[r]).toBe(0);
    }
    // The super-root's subtree node cost is the full graph (it stands in for all 200 nodes).
    expect(h.columns.subtreeNodeCost[h.superRoot]).toBe(200);
  });

  test("an empty / fully-filtered graph builds no synthetic reps (no roots to adopt)", () => {
    const { snap, nodeIds } = flatSnapshot(0, 10, 10);
    // Hide every node via the post-filter mask → no natural roots.
    const h = buildRepresentationHierarchy(snap, nodeIds, {
      bootstrapRoots: true,
      visibleNode: () => false,
    });
    expect(h.superRoot).toBe(-1);
    expect(h.roots).toEqual([]);
    expect(h.repCount).toBe(0 + 10); // no synthetic reps appended
  });

  test("a single natural root is still wrapped (uniform one-card coarsest cut)", () => {
    const { snap, nodeIds } = flatSnapshot(1, 5, 0); // one group, no orphans → one natural root
    const h = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    expect(h.roots).toEqual([h.superRoot]);
    expect(rootCut(h).cardCost).toBe(1);
    expect(h.columns.parentByRep[0]).toBe(h.superRoot); // the lone group root adopted
  });

  test("group/leaf rep ids are byte-identical to the un-normalized build", () => {
    const { snap, nodeIds } = flatSnapshot(3, 30, 15);
    const plain = buildRepresentationHierarchy(snap, nodeIds);
    const boot = buildRepresentationHierarchy(snap, nodeIds, { bootstrapRoots: true });
    // Group reps + leaf reps occupy the same ids; only the appended synthetic tier differs.
    const base = snap.groupIds.length + nodeIds.length;
    for (let r = 0; r < base; r++) {
      expect(boot.columns.groupByRep[r]).toBe(plain.columns.groupByRep[r]);
      expect(boot.columns.leafRepresentationByNode).toEqual(plain.columns.leafRepresentationByNode);
    }
    expect(boot.repOfGroup).toEqual(plain.repOfGroup);
  });
});

describe("representationBuilderVersion", () => {
  test("is a non-empty string the material signature can fold in", () => {
    expect(typeof representationBuilderVersion).toBe("string");
    expect(representationBuilderVersion.length).toBeGreaterThan(0);
  });
});
