// Gap 3 / P2 "stable-proxy-geometry": the representation cut must OPERATE with EVERY visual
// layout engine — not merely ignore the engine name. Grid, the classic engines, and None emit
// NO cluster boxes, so historically the cut went inert under them (every proxy read as height-0 /
// off-screen, `canRefine` short-circuited, the canvas early-returned on `boxes.size === 0`). With
// stable, layout-independent proxy bounds the cut now refines under a box-less engine exactly as
// it does under Smart's live boxes.

import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  type RepLodResult,
} from "./lod-representation-cut";
import type { CollapseIntent } from "./collapse-model";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// A non-trivial directory graph: a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c
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

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

/** Smart-engine boxes: live cluster boxes for every directory group. */
const smartBoxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 2000, h: 2000 }],
    ["a/x", { x: 0, y: 0, w: 900, h: 900 }],
    ["a/y", { x: 0, y: 1000, w: 900, h: 900 }],
    ["b", { x: 0, y: 0, w: 2000, h: 2000 }],
    ["b/z", { x: 0, y: 0, w: 2000, h: 2000 }],
  ]);

/** A box-less engine (Grid / Stress / Force / None) — emits NO cluster boxes at all. */
const noBoxes = (): Map<string, Box> => new Map<string, Box>();

function solve(boxes: Map<string, Box>, cam: Camera, intent: CollapseIntent = noIntent) {
  return buildSceneRepresentationCut({
    snapshot: snap,
    nodeIds,
    boxes,
    cam,
    vp,
    intent,
    options: opts,
  });
}

/** Selected reps that have geometry (positive bounds) — the "bounded result". */
function boundedSelectedCount(r: RepLodResult): number {
  const cols = r.hierarchy.columns;
  let n = 0;
  for (const rep of r.cut.selectedRepresentations) {
    if (cols.boundsW[rep] > 0 && cols.boundsH[rep] > 0) n++;
  }
  return n;
}

describe("rep cut with NO cluster boxes (Grid/Stress/Force/None) — Gap 3 / P2", () => {
  // A camera zoomed in enough that a top group's STABLE box clears openPx — so it should refine.
  const zoomedIn: Camera = { x: 0, y: 0, scale: 1 };

  test("a box-less engine still produces a NON-EMPTY, BOUNDED cut (not inert)", () => {
    const r = solve(noBoxes(), zoomedIn);
    expect(r.cut.selectedRepresentations.length).toBeGreaterThan(0);
    // Every selected rep has real geometry from the stable layout (none is height-0).
    expect(boundedSelectedCount(r)).toBe(r.cut.selectedRepresentations.length);
  });

  test("the cut REFINES under a box-less engine (zoom-in opens a group), not stuck at roots", () => {
    const out = solve(noBoxes(), zoomedIn);
    const root = solve(noBoxes(), { x: 0, y: 0, scale: 0.001 }); // far zoomed out
    // Zooming in selects MORE reps than the fully-collapsed root cut — refinement happened
    // purely on stable geometry, with zero engine boxes.
    expect(out.cut.selectedRepresentations.length).toBeGreaterThan(
      root.cut.selectedRepresentations.length,
    );
  });

  test("parity with Smart: box-less engine refines the SAME way (non-empty both)", () => {
    const withBoxes = solve(smartBoxes(), zoomedIn);
    const without = solve(noBoxes(), zoomedIn);
    // Both engines yield a usable cut — the box-less one is no longer inert.
    expect(withBoxes.cut.selectedRepresentations.length).toBeGreaterThan(0);
    expect(without.cut.selectedRepresentations.length).toBeGreaterThan(0);
    // Both cover every node exactly once (a valid antichain regardless of engine).
    assertCoversEveryNodeOnce(withBoxes);
    assertCoversEveryNodeOnce(without);
  });

  test("fully zoomed out under a box-less engine collapses to a bounded root proxy set", () => {
    const r = solve(noBoxes(), { x: 0, y: 0, scale: 0.001 });
    expect(r.cut.selectedRepresentations.length).toBeGreaterThan(0);
    expect(boundedSelectedCount(r)).toBe(r.cut.selectedRepresentations.length);
    assertCoversEveryNodeOnce(r);
  });

  test("a forced-open group is honored under a box-less engine", () => {
    const intent: CollapseIntent = new Map([["directory:a", "open"]]);
    const r = solve(noBoxes(), { x: 0, y: 0, scale: 0.001 }, intent);
    // 'a' is open → its box key is NOT in the collapsed set even fully zoomed out.
    expect(r.collapsedBoxKeys.has("a")).toBe(false);
    assertCoversEveryNodeOnce(r);
  });
});

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
    expect(hits).toBe(1);
  }
}
