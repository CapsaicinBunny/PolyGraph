import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import { groupLodSelection } from "./group-cut";
import {
  activeProxyBoxKeyOfNode,
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
} from "./lod-representation-cut";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5}
const graph: GraphModel = {
  nodes: [file("a/x/f1.c"), file("a/x/f2.c"), file("a/y/f3.c"), file("b/z/f4.c"), file("b/z/f5.c")],
  edges: [makeEdge("a/x/f1.c", "b/z/f4.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();

// World boxes (the live scene's clusters): "a" near the origin, "b" far to the right.
const boxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
    ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
    ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
    ["b", { x: 5000, y: 0, w: 1000, h: 1000 }],
    ["b/z", { x: 5000, y: 0, w: 1000, h: 1000 }],
  ]);

const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

/** Solve from scratch (no previous runtime) and return the result. */
function solve(cam: Camera, intent: CollapseIntent = noIntent) {
  return buildSceneRepresentationCut({
    snapshot: snap,
    nodeIds,
    boxes: boxes(),
    cam,
    vp,
    intent,
    options: opts,
  });
}

describe("buildSceneRepresentationCut — valid antichain + collapse-shaped derivation", () => {
  test("fully zoomed out: every group collapses to its proxy; the cut is a valid antichain", () => {
    const r = solve({ x: 0, y: 0, scale: 0.01 }); // every box ~10px tall
    // Every TOP group is collapsed (its box key present in the collapsed set).
    expect(r.collapsedBoxKeys.has("a")).toBe(true);
    expect(r.collapsedBoxKeys.has("b")).toBe(true);
    // The derived open selection equals groupLodSelection over the collapsed set.
    expect([...r.openSelection].sort()).toEqual(
      [...groupLodSelection(r.collapsedBoxKeys, snap)].sort(),
    );
    assertValidAntichain(r);
  });

  test("zoomed into 'a': a refines (not collapsed) while the off-screen 'b' stays a proxy", () => {
    // Camera scale 1, centred on a (origin). a's box is 1000px tall → well above openPx; b
    // is off-screen (x 5000).
    const r = solve({ x: 0, y: 0, scale: 1 });
    expect(r.collapsedBoxKeys.has("a")).toBe(false); // a opened
    expect(r.collapsedBoxKeys.has("b")).toBe(true); // b still a proxy (off-screen)
    assertValidAntichain(r);
  });

  test("the derived openSelection is exactly groupLodSelection(collapsed, snapshot)", () => {
    const r = solve({ x: 0, y: 0, scale: 1 });
    expect([...r.openSelection].sort()).toEqual(
      [...groupLodSelection(r.collapsedBoxKeys, snap)].sort(),
    );
  });
});

describe("buildSceneRepresentationCut — user intent constrains the cut", () => {
  test("forceClosed (user-collapsed) keeps a large on-screen group as a proxy", () => {
    const intent: CollapseIntent = new Map([["directory:a", "closed"]]);
    const r = solve({ x: 0, y: 0, scale: 1 }, intent);
    expect(r.collapsedBoxKeys.has("a")).toBe(true); // user closed it → proxy, despite size
    assertValidAntichain(r);
  });

  test("forceOpen (user-expanded) refines a small/off-screen group past its proxy", () => {
    const intent: CollapseIntent = new Map([["directory:b", "open"]]);
    const r = solve({ x: 0, y: 0, scale: 1 }, intent);
    // b is off-screen so auto would collapse it; the user forced it open → not collapsed.
    expect(r.collapsedBoxKeys.has("b")).toBe(false);
    assertValidAntichain(r);
  });
});

describe("activeProxyBoxKeyOfNode — a selected hidden node highlights its active proxy", () => {
  test("a node inside a collapsed group maps to that group's proxy box key", () => {
    const r = solve({ x: 0, y: 0, scale: 0.01 }); // everything collapsed
    // f4 lives in b/z → its active proxy is the outermost selected ancestor, box key "b".
    const key = activeProxyBoxKeyOfNode(r, nodeIds.indexOf("b/z/f4.c"));
    expect(key).toBe("b");
  });

  test("a node whose own leaf rep is selected maps to null (it's visible, no proxy)", () => {
    // Open everything (huge boxes, zoomed in, big budget): leaves selected.
    const big = { ...opts, maxCards: 100000, nodeBudget: 100000 };
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: new Map<string, Box>([
        ["a", { x: 0, y: 0, w: 100, h: 100 }],
        ["a/x", { x: 0, y: 0, w: 100, h: 100 }],
        ["a/y", { x: 0, y: 0, w: 100, h: 100 }],
        ["b", { x: 0, y: 0, w: 100, h: 100 }],
        ["b/z", { x: 0, y: 0, w: 100, h: 100 }],
      ]),
      cam: { x: 0, y: 0, scale: 100 }, // everything huge on screen
      vp,
      intent: noIntent,
      options: big,
    });
    // When the cut reaches a node's own leaf rep, it is its own representative → no proxy.
    const ord = nodeIds.indexOf("a/x/f1.c");
    // Only assert null if f1's leaf rep is actually selected (fully refined).
    const selected = new Set(r.cut.selectedRepresentations);
    const leaf = r.hierarchy.columns.leafRepresentationByNode[ord];
    if (selected.has(leaf)) {
      expect(activeProxyBoxKeyOfNode(r, ord)).toBeNull();
    }
  });
});

describe("buildSceneRepresentationCut — committed-generation gating via runtime", () => {
  test("re-solving with the SAME inputs commits nothing new (immaterial)", () => {
    const r1 = solve({ x: 0, y: 0, scale: 1 });
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: opts,
      previous: r1.runtime,
    });
    // Same selected reps → no material change → generation unchanged, committed flag false.
    expect(r2.committed).toBe(false);
    expect(r2.runtime.generation).toBe(r1.runtime.generation);
  });

  test("a materially-different solve (zoom in) commits and bumps the generation", () => {
    const r1 = solve({ x: 0, y: 0, scale: 0.01 }); // all collapsed
    const gen0 = r1.runtime.generation; // capture BEFORE r2 mutates the shared runtime
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 }, // zoom into a
      vp,
      intent: noIntent,
      options: opts,
      previous: r1.runtime,
    });
    expect(r2.committed).toBe(true);
    expect(r2.runtime.generation).toBe(gen0 + 1);
  });
});

/** Assert every node is represented exactly once by the solved cut. */
function assertValidAntichain(r: ReturnType<typeof solve>) {
  const selected = new Set(r.cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = r.hierarchy.columns;
  for (let i = 0; i < nodeIds.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = r.hierarchy.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    expect(hits).toBe(1);
  }
}
