// Gap 2 / P2 "synthetic None through the representation cut": None has no visible containers,
// but a large repo must still be bounded by the render budget. The fix wires the EXISTING
// `syntheticNoneGrouping` (connected components → communities) into the representation cut via a
// grouping snapshot, and the P2 stable proxy bounds let that cut OPERATE with no live cluster
// boxes at all (None emits none). This test exercises the None snapshot end-to-end through
// `buildSceneRepresentationCut` under a box-less engine: it must produce a non-empty, bounded,
// valid-antichain cut that REFINES on zoom — exactly the budget-feasibility None previously lacked.

import { describe, expect, test } from "bun:test";
import { syntheticNoneGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  type RepLodResult,
} from "./lod-representation-cut";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel, makeEdge } from "./types";

const file = (id: string) => ({
  id,
  kind: "file" as const,
  label: id,
  filePath: id,
  line: 0,
  parentFile: id,
});
const E = (a: string, b: string) => makeEdge(a, b, "import");

// Two connected components {a,b,c,d} and {x,y,z}, plus an isolated node `iso` — the synthetic
// None hierarchy must give every one of them a representation path (no orphan over budget).
const graph: GraphModel = {
  nodes: ["a", "b", "c", "d", "x", "y", "z", "iso"].map(file),
  edges: [E("a", "b"), E("b", "c"), E("c", "d"), E("x", "y"), E("y", "z")],
};
const nodeIds = graph.nodes.map((n) => n.id);
// Exactly the snapshot the canvas now builds for `groupBy === "none"`.
const snap = buildGroupingSnapshot(syntheticNoneGrouping(graph), "none", nodeIds);

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

/** None emits NO cluster boxes at all — the whole point of the stable-bounds path. */
const noBoxes = (): Map<string, Box> => new Map<string, Box>();

function solve(cam: Camera, intent: CollapseIntent = noIntent): RepLodResult {
  return buildSceneRepresentationCut({
    snapshot: snap,
    nodeIds,
    boxes: noBoxes(),
    cam,
    vp,
    intent,
    options: opts,
  });
}

function assertCoversEveryNodeOnce(r: RepLodResult) {
  const selected = new Set(r.cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = r.hierarchy.columns;
  for (let i = 0; i < nodeIds.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = r.hierarchy.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    expect(hits).toBe(1); // a valid antichain: every node represented exactly once
  }
}

describe("None via syntheticNoneGrouping through the representation cut — Gap 2 / P2", () => {
  test("a budget-feasible bootstrap cut exists with NO boxes (None not inert)", () => {
    const r = solve({ x: 0, y: 0, scale: 0.001 }); // fully zoomed out
    expect(r.cut.selectedRepresentations.length).toBeGreaterThan(0);
    // Bounded: the coarsest cut is well within the hard card budget (no orphan explosion).
    expect(r.cut.selectedRepresentations.length).toBeLessThanOrEqual(opts.nodeBudget);
    assertCoversEveryNodeOnce(r);
  });

  test("the None cut REFINES on zoom-in purely on stable bounds (no engine boxes)", () => {
    const root = solve({ x: 0, y: 0, scale: 0.001 });
    const zoomed = solve({ x: 0, y: 0, scale: 1 });
    expect(zoomed.cut.selectedRepresentations.length).toBeGreaterThan(
      root.cut.selectedRepresentations.length,
    );
    assertCoversEveryNodeOnce(zoomed);
  });

  test("every selected rep has real stable geometry (none is height-0)", () => {
    const r = solve({ x: 0, y: 0, scale: 1 });
    const cols = r.hierarchy.columns;
    for (const rep of r.cut.selectedRepresentations) {
      expect(cols.boundsW[rep]).toBeGreaterThan(0);
      expect(cols.boundsH[rep]).toBeGreaterThan(0);
    }
  });

  test("renders FLAT: the cut derives no live group boxes (None draws no containers)", () => {
    // With no engine boxes and a coarse camera, the collapsed set is keyed off synthetic group
    // box keys — but None never feeds those to a renderer (no ClusterBox match), so this only
    // asserts the cut still completes and is a valid antichain regardless of geometry source.
    const r = solve({ x: 0, y: 0, scale: 0.001 });
    assertCoversEveryNodeOnce(r);
  });
});

describe("None — a LARGE disconnected graph stays budget-feasible (Gap 2 needs P0.5 normalization)", () => {
  // The common None shape: MANY isolated / disconnected files. Each isolated node is its own
  // connected component → its own community → its own synthetic group ROOT. WITHOUT the rep
  // builder's P0.5 super-root / intermediate-tier normalization, the coarsest antichain would be
  // one card PER component (here ~600), starting OVER the hard budget — and since refinement only
  // ADDS cards, the cut could never become feasible. With normalization (which
  // buildSceneRepresentationCut now always applies), the bootstrap collapses to a bounded set of
  // render-only proxies, so a fully-zoomed-out None cut is a handful of cards, not 600.
  const N = 600;
  const bigGraph: GraphModel = {
    nodes: Array.from({ length: N }, (_, i) => file(`iso${i}`)),
    edges: [], // every node isolated → N components → N synthetic roots
  };
  const bigIds = bigGraph.nodes.map((n) => n.id);
  const bigSnap = buildGroupingSnapshot(syntheticNoneGrouping(bigGraph), "none", bigIds);

  const bigOpts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

  function bigSolve(cam: Camera): RepLodResult {
    return buildSceneRepresentationCut({
      snapshot: bigSnap,
      nodeIds: bigIds,
      boxes: noBoxes(),
      cam,
      vp,
      intent: noIntent,
      options: bigOpts,
    });
  }

  function assertCoversBigOnce(r: RepLodResult) {
    const selected = new Set(r.cut.selectedRepresentations);
    const { parentByRep, leafRepresentationByNode } = r.hierarchy.columns;
    for (let i = 0; i < bigIds.length; i++) {
      let cur = leafRepresentationByNode[i];
      let hits = 0;
      let guard = r.hierarchy.repCount + 1;
      while (cur >= 0 && guard-- > 0) {
        if (selected.has(cur)) hits++;
        cur = parentByRep[cur];
      }
      expect(hits).toBe(1);
    }
  }

  test("the coarsest None cut is a BOUNDED handful of cards, not one-per-component", () => {
    const r = bigSolve({ x: 0, y: 0, scale: 0.0001 }); // fully zoomed out
    // Feasible: far under the hard budget — and FAR fewer than the N natural roots, proving the
    // synthetic super-root / bucket tier folded them (un-normalized this would be N == 600 cards).
    expect(r.cut.cardCost).toBeLessThanOrEqual(bigOpts.nodeBudget);
    expect(r.cut.cardCost).toBeLessThan(N);
    assertCoversBigOnce(r);
  });

  test("every node is represented exactly once across zoom levels (valid antichain)", () => {
    for (const scale of [0.0001, 0.01, 1]) {
      const r = bigSolve({ x: 0, y: 0, scale });
      assertCoversBigOnce(r);
      expect(r.cut.cardCost).toBeLessThanOrEqual(bigOpts.nodeBudget);
    }
  });
});
