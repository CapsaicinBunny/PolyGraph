import { describe, expect, test } from "bun:test";
import { communityGrouping, facetGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { budgetGroupCut, computeGroupCut, groupCutEquals, groupLodSelection } from "./group-cut";
import type { Box, Camera, Viewport } from "./lod-screen";
import type { DimensionDescriptor } from "./dimensions";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const withFacet = (path: string, facets: Record<string, string[]>) => ({ ...file(path), facets });
const E = (s: string, t: string) => makeEdge(s, t, "import");

const vp: Viewport = { w: 800, h: 600 };

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
// Each community's box (bareId == community id), placed far apart so visibility is per-box.
const groupA = chier.groupOfNode("a")!; // "community:Community N"
const groupX = chier.groupOfNode("x")!;
const boxA = chier.boxKey(groupA);
const boxX = chier.boxKey(groupX);

describe("computeGroupCut — a NON-directory (community) mode produces a cut", () => {
  test("a big on-screen community box opens; an off-screen one collapses", () => {
    const boxes = new Map<string, Box>([
      [boxA, { x: 0, y: 0, w: 1000, h: 1000 }], // fills the view
      [boxX, { x: 50000, y: 0, w: 1000, h: 1000 }], // way off screen
    ]);
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const cut = computeGroupCut(csnap, boxes, cam, vp, { openPx: 220, maxCards: 100 });
    expect(cut.has(boxA)).toBe(false); // opened (its members render)
    expect(cut.has(boxX)).toBe(true); // collapsed (off-screen)
  });

  test("a tiny on-screen box collapses (too small to be legible)", () => {
    const boxes = new Map<string, Box>([
      [boxA, { x: 0, y: 0, w: 1000, h: 10 }], // 10px tall → below openPx
    ]);
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const cut = computeGroupCut(csnap, boxes, cam, vp, { openPx: 220, maxCards: 100 });
    expect(cut.has(boxA)).toBe(true);
  });

  test("a group with NO box (collapsed away / not materialized) defaults to collapse", () => {
    const cut = computeGroupCut(csnap, new Map(), { x: 0, y: 0, scale: 1 }, vp, {
      openPx: 220,
      maxCards: 100,
    });
    // Both community boxes missing → both collapse (the safe default, as directory does).
    expect(cut.has(boxA)).toBe(true);
    expect(cut.has(boxX)).toBe(true);
  });
});

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

describe("computeGroupCut — budget bounds the open set (None safety / large graphs)", () => {
  test("maxCards caps how many group members open before the rest collapse", () => {
    // Two communities, each big on screen, but maxCards=3 forces the second to collapse.
    const boxes = new Map<string, Box>([
      [boxA, { x: 0, y: 0, w: 1000, h: 1000 }],
      [boxX, { x: 0, y: 1100, w: 1000, h: 1000 }],
    ]);
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const cut = computeGroupCut(csnap, boxes, cam, vp, { openPx: 100, maxCards: 3 });
    // The first community (3 members) opens; the budget is then spent → the second collapses.
    const openCount = [boxA, boxX].filter((b) => !cut.has(b)).length;
    expect(openCount).toBeLessThan(2);
  });

  test("nodeBudget (not just maxCards) caps the open set on the generic path", () => {
    // Both communities big on screen, maxCards generous, but a per-node cost of 2 with a
    // nodeBudget of 4 lets only the first community's 3 members (cost 6 > 4 → actually the
    // budget stops it). Use cost 1 and nodeBudget 4 so exactly one 3-member community opens.
    const boxes = new Map<string, Box>([
      [boxA, { x: 0, y: 0, w: 1000, h: 1000 }],
      [boxX, { x: 0, y: 1100, w: 1000, h: 1000 }],
    ]);
    const cut = computeGroupCut(
      csnap,
      boxes,
      { x: 0, y: 0, scale: 1 },
      vp,
      { openPx: 100, maxCards: 1000, nodeBudget: 4, nodeCost: () => 1 },
      cnodeIds,
    );
    // maxCards alone would open both (6 cards < 1000); the nodeBudget=4 stops the second.
    const openCount = [boxA, boxX].filter((b) => !cut.has(b)).length;
    expect(openCount).toBeLessThan(2);
  });
});

describe("computeGroupCut — hysteresis on the generic (non-directory) path", () => {
  // A single community box whose on-screen height sits between openPx*hysteresis and openPx,
  // so the decision depends ENTIRELY on whether it was previously open (panning stability).
  const boxes = (h: number) => new Map<string, Box>([[boxA, { x: 0, y: 0, w: 1000, h }]]);
  const cam: Camera = { x: 0, y: 0, scale: 1 };
  // openPx 200, hysteresis 0.8 → relaxed threshold 160. Box 180px tall: below 200, above 160.
  const opts = { openPx: 200, hysteresis: 0.8, maxCards: 100 };

  test("a box that WAS open stays open under the relaxed openPx*hysteresis threshold", () => {
    // prevCut does NOT contain boxA → wasOpen(boxA) is true → threshold 160; 180 ≥ 160 → open.
    const cut = computeGroupCut(
      csnap,
      boxes(180),
      cam,
      vp,
      { ...opts, prevCut: new Set() },
      cnodeIds,
    );
    expect(cut.has(boxA)).toBe(false);
  });

  test("the SAME box, when it was collapsed, stays collapsed (full openPx threshold)", () => {
    // prevCut contains boxA → wasOpen is false → threshold 200; 180 < 200 → collapse.
    const cut = computeGroupCut(
      csnap,
      boxes(180),
      cam,
      vp,
      { ...opts, prevCut: new Set([boxA]) },
      cnodeIds,
    );
    expect(cut.has(boxA)).toBe(true);
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

// ── A facet-grouped graph: groups keyed by "facet:env:<value>". ───────────────
const envDescriptor: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client" },
    { value: "server", label: "Server" },
  ],
  providerIds: ["core"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

describe("computeGroupCut — facet mode (boxKey == namespaced facet id)", () => {
  const fgraph: GraphModel = {
    nodes: [
      withFacet("a.ts", { env: ["client"] }),
      withFacet("b.ts", { env: ["client"] }),
      withFacet("c.ts", { env: ["server"] }),
    ],
    edges: [],
  };
  const fhier = facetGrouping(fgraph, envDescriptor)!;
  const fsnap = buildGroupingSnapshot(
    fhier,
    "facet:env",
    fgraph.nodes.map((n) => n.id),
  );

  test("the facet box key is the namespaced id, and the cut measures it", () => {
    const boxes = new Map<string, Box>([
      ["facet:env:client", { x: 0, y: 0, w: 1000, h: 1000 }],
      ["facet:env:server", { x: 50000, y: 0, w: 1000, h: 1000 }],
    ]);
    const cut = computeGroupCut(fsnap, boxes, { x: 0, y: 0, scale: 1 }, vp, {
      openPx: 220,
      maxCards: 100,
    });
    expect(cut.has("facet:env:client")).toBe(false); // open
    expect(cut.has("facet:env:server")).toBe(true); // off-screen → collapsed
    const open = groupLodSelection(cut, fsnap);
    expect(open.has("facet:env:client")).toBe(true);
  });
});

describe("groupCutEquals", () => {
  test("set equality drives the no-op skip", () => {
    expect(groupCutEquals(new Set(["a"]), new Set(["a"]))).toBe(true);
    expect(groupCutEquals(new Set(["a"]), new Set(["b"]))).toBe(false);
    expect(groupCutEquals(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});
