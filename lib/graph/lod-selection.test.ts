import { describe, expect, test } from "bun:test";
import { compose } from "./collapse-model";
import { collapseClusters } from "./collapse";
import { computeCut } from "./lod-cut";
import { allDirectoryGroupIds, toDirectoryBoxKeys } from "./grouping";
import { buildDirTree } from "./hierarchy";
import type { Box } from "./lod-screen";
import { directoryLodSelection } from "./lod-selection";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// drivers/{net/{a,b,c}, gpu/{d,e}}, fs/{f,g}
const graph: GraphModel = {
  nodes: [
    file("drivers/net/a.c"),
    file("drivers/net/b.c"),
    file("drivers/net/c.c"),
    file("drivers/gpu/d.c"),
    file("drivers/gpu/e.c"),
    file("fs/f.c"),
    file("fs/g.c"),
  ],
  edges: [],
};

describe("directoryLodSelection — open-dir set from a collapsed cut", () => {
  test("a directory is open iff neither it nor any ancestor is in the cut", () => {
    const cut = new Set(["drivers/gpu", "fs"]); // drivers + drivers/net open; gpu, fs collapsed
    const sel = directoryLodSelection(cut, graph);
    expect([...sel].sort()).toEqual(["directory:drivers", "directory:drivers/net"]);
  });

  test("an empty cut opens every directory", () => {
    const sel = directoryLodSelection(new Set(), graph);
    expect(sel).toEqual(allDirectoryGroupIds(graph));
  });

  test("a top-level collapse opens nothing under it", () => {
    const sel = directoryLodSelection(new Set(["drivers"]), graph);
    // fs and its (none) stay open; everything under drivers is closed.
    expect([...sel].sort()).toEqual(["directory:fs"]);
  });

  test("ignores cut entries that aren't directories in this graph", () => {
    const sel = directoryLodSelection(new Set(["nope/zzz"]), graph);
    expect(sel).toEqual(allDirectoryGroupIds(graph)); // unknown collapse closes nothing real
  });
});

describe("directoryLodSelection — round-trips computeCut through compose() identically", () => {
  // The behavior-preservation invariant: composing (∅ intent, all-dirs bootstrap, the
  // camera's open selection) yields EXACTLY the camera's computeCut collapsed set, so
  // the rendered scene is byte-identical to feeding computeCut straight to
  // collapseClusters (the pre-refactor path).
  const tree = buildDirTree(graph);
  const boxes = new Map<string, Box>([
    ["drivers", { x: 0, y: 0, w: 2000, h: 2000 }],
    ["drivers/net", { x: 0, y: 0, w: 1000, h: 1000 }],
    ["drivers/gpu", { x: 0, y: 1100, w: 1000, h: 800 }],
    ["fs", { x: 5000, y: 0, w: 1000, h: 1000 }],
  ]);
  const vp = { w: 800, h: 600 };

  const renderedIds = (collapsed: Set<string>) =>
    collapseClusters(graph, collapsed)
      .nodes.map((n) => n.id)
      .sort();

  test("effective collapsed (no intent) equals the raw camera cut", () => {
    const cam = { x: 0, y: 0, scale: 1 }; // drivers fills view, fs off-screen
    const cut = computeCut(tree, boxes, cam, vp, { openPx: 220, maxCards: 1000 });
    const selection = directoryLodSelection(cut, graph);
    const bootstrapClosed = allDirectoryGroupIds(graph);
    const effective = toDirectoryBoxKeys(
      compose({ intent: new Map(), bootstrapClosed, selection }),
    );
    expect([...effective].sort()).toEqual([...cut].sort());
    expect(renderedIds(effective)).toEqual(renderedIds(cut));
  });

  test("the equivalence holds across several camera positions", () => {
    const bootstrapClosed = allDirectoryGroupIds(graph);
    for (const cam of [
      { x: 0, y: 0, scale: 0.05 }, // zoomed out — most collapsed
      { x: 0, y: 0, scale: 1 },
      { x: -5000, y: 0, scale: 1 }, // panned to fs
      { x: 0, y: 0, scale: 3 }, // zoomed in
    ]) {
      const cut = computeCut(tree, boxes, cam, vp, { openPx: 220, maxCards: 1000 });
      const selection = directoryLodSelection(cut, graph);
      const effective = toDirectoryBoxKeys(
        compose({ intent: new Map(), bootstrapClosed, selection }),
      );
      expect(renderedIds(effective)).toEqual(renderedIds(cut));
    }
  });
});
