import { describe, expect, test } from "bun:test";
import type { LayoutInput } from "../layout";
import { buildSmartGroupingSnapshot, smartLayout } from "./smart";

const N = (id: string, kind = "file") => ({ id, kind });
const E = (source: string, target: string) => ({ source, target });

// A multi-directory view with a compressible chain, a cycle, and a few shapes —
// enough that the layout exercises several engines and nesting depths.
const view: LayoutInput = {
  nodes: [
    N("pkg/a.ts"),
    N("pkg/b.ts"),
    N("pkg/sub/c.ts"),
    N("pkg/sub/d.ts"),
    N("util/x.ts"),
    N("src/lib/graph/y.ts"),
    N("cyc/p.ts"),
    N("cyc/q.ts"),
    N("cyc/r.ts"),
  ],
  edges: [
    E("pkg/a.ts", "pkg/b.ts"),
    E("pkg/sub/c.ts", "pkg/sub/d.ts"),
    E("pkg/a.ts", "pkg/sub/c.ts"),
    E("cyc/p.ts", "cyc/q.ts"),
    E("cyc/q.ts", "cyc/r.ts"),
    E("cyc/r.ts", "cyc/p.ts"),
  ],
};

/**
 * The Phase C1a byte-identity contract: Smart driven by the injected snapshot must
 * produce EXACTLY the same node positions and cluster boxes as legacy Smart deriving
 * the tree from node ids — for Directory. (Verified here at the smartLayout boundary,
 * complementing the cluster-tree round-trip in clusters-snapshot.test.ts.)
 */
describe("smartLayout via injected snapshot == legacy smartLayout (Directory, byte-identical)", () => {
  for (const direction of ["TB", "LR", "BT", "RL"] as const) {
    test(`direction ${direction}: positions + clusters are byte-identical`, () => {
      const snapshot = buildSmartGroupingSnapshot(view, "directory", undefined, "directory");
      const legacy = smartLayout(view, { direction, groupBy: "directory" });
      const viaSnap = smartLayout(view, { direction, groupBy: "directory", groupingSnapshot: snapshot });
      expect([...viaSnap.nodes.entries()]).toEqual([...legacy.nodes.entries()]);
      expect(viaSnap.clusters).toEqual(legacy.clusters);
    });
  }

  test("density is honored identically through the snapshot path", () => {
    const snapshot = buildSmartGroupingSnapshot(view, "directory", undefined, "directory");
    const legacy = smartLayout(view, { direction: "LR", groupBy: "directory", density: 1.6 });
    const viaSnap = smartLayout(view, {
      direction: "LR",
      groupBy: "directory",
      density: 1.6,
      groupingSnapshot: snapshot,
    });
    expect([...viaSnap.nodes.entries()]).toEqual([...legacy.nodes.entries()]);
    expect(viaSnap.clusters).toEqual(legacy.clusters);
  });

  test("the cluster box ids are the directory paths (LOD contract intact)", () => {
    const snapshot = buildSmartGroupingSnapshot(view, "directory", undefined, "directory");
    const viaSnap = smartLayout(view, { direction: "LR", groupBy: "directory", groupingSnapshot: snapshot });
    const ids = new Set(viaSnap.clusters.map((c) => c.id));
    expect(ids.has("pkg")).toBe(true);
    expect(ids.has("util")).toBe(true);
    expect(ids.has("cyc")).toBe(true);
    expect(ids.has("src/lib/graph")).toBe(true); // compressed chain
  });
});

describe("smartLayout via snapshot == legacy (Community), byte-identical", () => {
  // A community-shaped view: two cliques + a bridge so detectCommunities forms ≥2 groups.
  const cv: LayoutInput = {
    nodes: ["a", "b", "c", "x", "y", "z"].map((id) => N(`${id}.ts`)),
    edges: [
      E("a.ts", "b.ts"),
      E("b.ts", "c.ts"),
      E("a.ts", "c.ts"),
      E("x.ts", "y.ts"),
      E("y.ts", "z.ts"),
      E("x.ts", "z.ts"),
      E("c.ts", "x.ts"),
    ],
  };

  test("community grouping matches between snapshot and legacy paths", () => {
    const snapshot = buildSmartGroupingSnapshot(cv, "community", undefined, "community");
    const legacy = smartLayout(cv, { direction: "LR", groupBy: "community" });
    const viaSnap = smartLayout(cv, { direction: "LR", groupBy: "community", groupingSnapshot: snapshot });
    expect([...viaSnap.nodes.entries()]).toEqual([...legacy.nodes.entries()]);
    expect(viaSnap.clusters).toEqual(legacy.clusters);
  });
});
