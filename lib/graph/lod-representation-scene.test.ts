// Integration: the representation cut's derived collapsed set drives the EXISTING scene
// collapse path (collapseClusters), so the rendered scene = the committed cut's selected
// proxies. Proves Task 5's "rendered scene = committed cut's selected representations
// (proxies)" without a GPU, through the real collapse transform.

import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
} from "./lod-representation-cut";
import { aggregateNodeId, collapseClusters, isAggregateId } from "./collapse";
import { toDirectoryBoxKeys } from "./grouping";
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

const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/y/f3.c"),
    file("b/z/f4.c"),
    file("b/z/f5.c"),
  ],
  edges: [makeEdge("a/x/f1.c", "b/z/f4.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const vp: Viewport = { w: 800, h: 600 };

const boxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
    ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
    ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
    ["b", { x: 5000, y: 0, w: 1000, h: 1000 }],
    ["b/z", { x: 5000, y: 0, w: 1000, h: 1000 }],
  ]);

const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

describe("representation cut → collapseClusters (the rendered scene is the cut's proxies)", () => {
  test("zoomed out: collapsing the cut's box keys yields aggregate proxy cards, no files", () => {
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 0.01 } as Camera,
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
    });
    // The render path consumes BARE box keys (directory paths); the cut already produced them.
    const collapsed = r.collapsedBoxKeys;
    const folded = collapseClusters(graph, collapsed);
    // Every original file is absorbed into an aggregate (no raw file nodes survive).
    const survivingFiles = folded.nodes.filter((n) => !isAggregateId(n.id) && n.kind === "file");
    expect(survivingFiles.length).toBe(0);
    // The aggregate cards correspond to the top groups a and b.
    const aggIds = new Set(folded.nodes.filter((n) => isAggregateId(n.id)).map((n) => n.id));
    expect(aggIds.has(aggregateNodeId("a"))).toBe(true);
    expect(aggIds.has(aggregateNodeId("b"))).toBe(true);
  });

  test("zoomed into 'a': a's files render while 'b' stays one aggregate proxy", () => {
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 } as Camera,
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
    });
    const folded = collapseClusters(graph, r.collapsedBoxKeys);
    const ids = new Set(folded.nodes.map((n) => n.id));
    // a's files are present (a opened); b is one aggregate.
    expect(ids.has("a/x/f1.c")).toBe(true);
    expect(ids.has("a/y/f3.c")).toBe(true);
    expect(ids.has(aggregateNodeId("b"))).toBe(true);
    expect(ids.has("b/z/f4.c")).toBe(false); // absorbed into the b proxy
  });

  test("the openSelection composes (via toDirectoryBoxKeys round-trip) to the same collapsed set", () => {
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 } as Camera,
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
    });
    // The Explorer composes intent+bootstrap+selection; with no intent and an all-groups
    // bootstrap, the COLLAPSED ids are the complement of openSelection among all groups.
    const allGroups = new Set(snap.groupIds);
    const composedCollapsedIds = new Set<string>();
    for (const g of allGroups) if (!r.openSelection.has(g)) composedCollapsedIds.add(g);
    // Reduce to the OUTERMOST collapsed (a parent's box key absorbs its children); the cut's
    // collapsedBoxKeys is already that frontier. Map composed ids → box keys and intersect.
    const composedBoxKeys = toDirectoryBoxKeys(composedCollapsedIds);
    // Every box key the cut collapsed is among the composed-collapsed set.
    for (const bk of r.collapsedBoxKeys) expect(composedBoxKeys.has(bk)).toBe(true);
  });
});
