import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy, type RepresentationHierarchy } from "./representation";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  cutSignature,
  cutSignaturesEqual,
  type LodBudget,
  type LodCut,
  makeRuntimeCut,
  rootCut,
  selectedRepresentationsHash,
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

/** A generous budget that lets the solver refine everything to leaves. */
const bigBudget: LodBudget = {
  targetNodes: 1000,
  targetEdges: 1000,
  targetLabels: 1000,
  hardNodes: 10000,
  hardEdges: 10000,
  hardLabels: 10000,
  maxGpuBytes: Infinity,
  maxLayoutWork: Infinity,
};
/** A tiny soft budget: auto refinement is heavily constrained. */
const tinyBudget: LodBudget = {
  targetNodes: 2,
  targetEdges: 1000,
  targetLabels: 1000,
  hardNodes: 4,
  hardEdges: 10000,
  hardLabels: 10000,
  maxGpuBytes: Infinity,
  maxLayoutWork: Infinity,
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
    expect(cut.nodeCost).toBeLessThanOrEqual(tinyBudget.hardNodes);
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
});

describe("solveLodCut — user-open may exceed soft but never hard (Appendix A §B)", () => {
  test("a forced open exceeds the soft target up to the hard ceiling", () => {
    // Soft target = 1 node; auto would stay at roots. Force-open every root group so the
    // whole graph must refine — exceeding soft, bounded by hard.
    const softOne: LodBudget = { ...tinyBudget, targetNodes: 1, hardNodes: 1000 };
    const a = groupRep(h, "directory:a");
    const b = groupRep(h, "directory:b");
    const c: CutConstraints = { forceClosed: new Set(), forceOpen: new Set([a, b]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, softOne);
    assertValidAntichain(h, cut);
    expect(cut.nodeCost).toBeGreaterThan(softOne.targetNodes); // exceeded soft
    expect(cut.nodeCost).toBeLessThanOrEqual(softOne.hardNodes); // within hard
  });

  test("a forced open that would breach the HARD ceiling retains the nearest legal proxy", () => {
    // Root cut = {a, b, top} = 3 cards. hardNodes = 4 holds that and ONE refine of a
    // (→ a/x, a/y, b, top = 4) but NOT a full open of a (a/x→f1,f2 would be 5 > 4). So a
    // is opened to its child proxies but a/x and a/y are retained — the deepest safe rep.
    const hardFour: LodBudget = {
      ...tinyBudget,
      targetNodes: 1,
      hardNodes: 4,
    };
    const a = groupRep(h, "directory:a");
    const c: CutConstraints = { forceClosed: new Set(), forceOpen: new Set([a]) };
    const cut = solveLodCut(h, bootstrapCut(h), c, cam, hardFour);
    assertValidAntichain(h, cut);
    expect(cut.nodeCost).toBeLessThanOrEqual(hardFour.hardNodes);
    expect(new Set(cut.selectedRepresentations).has(a)).toBe(false); // a IS opened
    // a/x and a/y are retained as proxies (couldn't fully open within hard).
    expect(new Set(cut.selectedRepresentations).has(groupRep(h, "directory:a/x"))).toBe(true);
  });
});

describe("solveLodCut — atomic refine/coarsen, byte-identical reject (Appendix A §E)", () => {
  test("a rejected refinement leaves the prior cut byte-identical", () => {
    // hardNodes below even the coarsest refine: the solver can make no progress, so the
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
    const noRefine: LodBudget = { ...tinyBudget, targetNodes: 0, hardNodes: 0 };
    const again = solveLodCut(h, seed, noConstraints, cam, noRefine);
    // The seed's two proxies already cost > 0; with hardNodes 0 nothing can change, and a
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
