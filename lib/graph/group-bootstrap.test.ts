// Regression gate for the retained mode-agnostic BOOTSTRAP seed (the survivors of the C1a
// retirement). The C1a camera cut (`computeGroupCut`) is gone; what remains is the
// geometry-free seed that translates intent/bootstrap into the `compose()` selection the
// representation cut renders on top of: `budgetGroupCut`, `groupLodSelection`,
// `groupCutEquals`. Pure — verified without a GPU.

import { describe, expect, test } from "bun:test";
import { communityGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { budgetGroupCut, groupCutEquals, groupLodSelection } from "./group-bootstrap";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const E = (s: string, t: string) => makeEdge(s, t, "import");

// ── A community-grouped graph: two cliques → two community groups. ────────────
const cgraph: GraphModel = {
  nodes: ["a", "b", "c", "x", "y", "z"].map(file),
  edges: [
    E("a", "b"),
    E("b", "c"),
    E("a", "c"),
    E("x", "y"),
    E("y", "z"),
    E("x", "z"),
    E("c", "x"),
  ],
};
const chier = communityGrouping(cgraph);
const cnodeIds = cgraph.nodes.map((n) => n.id);
const csnap = buildGroupingSnapshot(chier, "community", cnodeIds);
const groupA = chier.groupOfNode("a")!;
const groupX = chier.groupOfNode("x")!;
const boxA = chier.boxKey(groupA);
const boxX = chier.boxKey(groupX);

describe("groupLodSelection — the GroupLodSelection (open namespaced group ids)", () => {
  test("an open box yields its namespaced group id in the selection", () => {
    const collapsed = new Set([boxX]); // only X collapsed
    const open = groupLodSelection(collapsed, csnap);
    expect(open.has(groupA)).toBe(true); // A open
    expect(open.has(groupX)).toBe(false); // X collapsed
  });

  test("everything collapsed → an empty selection", () => {
    const open = groupLodSelection(new Set([boxA, boxX]), csnap);
    expect(open.size).toBe(0);
  });

  test("nothing collapsed → every group open", () => {
    const open = groupLodSelection(new Set(), csnap);
    expect(open.has(groupA)).toBe(true);
    expect(open.has(groupX)).toBe(true);
  });
});

describe("budgetGroupCut — geometry-free initial budget cut (the non-directory seed)", () => {
  test("returns null when the whole snapshot fits the budget (LOD off)", () => {
    // 6 nodes, generous budgets → nothing to bound.
    expect(budgetGroupCut(csnap, { maxCards: 1000, nodeBudget: 1000 }, cnodeIds)).toBeNull();
  });

  test("bounds the open set when over budget (heaviest-first), the rest collapse", () => {
    const cut = budgetGroupCut(csnap, { maxCards: 3, nodeBudget: 1000 }, cnodeIds)!;
    expect(cut).not.toBeNull();
    // One 3-member community opens (3 cards == maxCards), the other collapses.
    const openCount = [boxA, boxX].filter((b) => !cut.has(b)).length;
    expect(openCount).toBeLessThan(2);
    // Feeding the open frontier through groupLodSelection yields a usable selection seed.
    const open = groupLodSelection(cut, csnap);
    expect(open.size).toBeGreaterThan(0);
  });

  test("honors a node-cost budget independent of the card cap", () => {
    // maxCards generous, but cost 1/node with nodeBudget 4 stops after the first community.
    const cut = budgetGroupCut(
      csnap,
      { maxCards: 1000, nodeBudget: 4, nodeCost: () => 1 },
      cnodeIds,
    )!;
    expect(cut).not.toBeNull();
    const openCount = [boxA, boxX].filter((b) => !cut.has(b)).length;
    expect(openCount).toBeLessThan(2);
  });
});

describe("groupCutEquals", () => {
  test("set equality drives the no-op skip", () => {
    expect(groupCutEquals(new Set(["a"]), new Set(["a"]))).toBe(true);
    expect(groupCutEquals(new Set(["a"]), new Set(["b"]))).toBe(false);
    expect(groupCutEquals(new Set(["a", "b"]), new Set(["a"]))).toBe(false);
  });
});
