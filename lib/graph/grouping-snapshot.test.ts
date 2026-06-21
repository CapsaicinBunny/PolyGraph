import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import {
  ancestorGroupOrdinals,
  buildGroupingSnapshot,
  type CompactGroupingSnapshot,
  groupPath,
  NO_GROUP,
} from "./grouping-snapshot";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c — top-level {a,b}; a→{a/x,a/y}; b→{b/z}; top.c at root.
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

/** The group ordinal whose namespaced id is `id`, or -1. */
function ordOf(s: CompactGroupingSnapshot, id: string): number {
  return s.groupIds.indexOf(id);
}

describe("buildGroupingSnapshot — columnar shape", () => {
  test("modeKey is carried through", () => {
    expect(snap.modeKey).toBe("directory");
  });

  test("groupIds enumerates every group exactly once (namespaced)", () => {
    expect([...snap.groupIds].sort()).toEqual([
      "directory:a",
      "directory:a/x",
      "directory:a/y",
      "directory:b",
      "directory:b/z",
    ]);
  });

  test("parallel arrays line up with groupIds length", () => {
    const n = snap.groupIds.length;
    expect(snap.groupLabels.length).toBe(n);
    expect(snap.parentByGroup.length).toBe(n);
    expect(snap.depthByGroup.length).toBe(n);
    expect(snap.boxKeyByGroup.length).toBe(n);
  });

  test("the typed arrays are exactly the spec types", () => {
    expect(snap.parentByGroup).toBeInstanceOf(Int32Array);
    expect(snap.depthByGroup).toBeInstanceOf(Uint16Array);
    expect(snap.directGroupByNode).toBeInstanceOf(Uint32Array);
    expect(snap.roots).toBeInstanceOf(Uint32Array);
  });

  test("roots are the parent=-1 groups (top-level directories)", () => {
    const rootIds = [...snap.roots].map((o) => snap.groupIds[o]).sort();
    expect(rootIds).toEqual(["directory:a", "directory:b"]);
    for (const o of snap.roots) expect(snap.parentByGroup[o]).toBe(-1);
  });

  test("parentByGroup links each child to its parent group ordinal", () => {
    expect(snap.parentByGroup[ordOf(snap, "directory:a/x")]).toBe(ordOf(snap, "directory:a"));
    expect(snap.parentByGroup[ordOf(snap, "directory:a/y")]).toBe(ordOf(snap, "directory:a"));
    expect(snap.parentByGroup[ordOf(snap, "directory:b/z")]).toBe(ordOf(snap, "directory:b"));
  });

  test("depthByGroup is 0 for roots, 1 for their children", () => {
    expect(snap.depthByGroup[ordOf(snap, "directory:a")]).toBe(0);
    expect(snap.depthByGroup[ordOf(snap, "directory:b")]).toBe(0);
    expect(snap.depthByGroup[ordOf(snap, "directory:a/x")]).toBe(1);
    expect(snap.depthByGroup[ordOf(snap, "directory:b/z")]).toBe(1);
  });

  test("boxKeyByGroup is the bare layout/LOD path (namespace stripped)", () => {
    expect(snap.boxKeyByGroup[ordOf(snap, "directory:a")]).toBe("a");
    expect(snap.boxKeyByGroup[ordOf(snap, "directory:a/x")]).toBe("a/x");
    expect(snap.boxKeyByGroup[ordOf(snap, "directory:b/z")]).toBe("b/z");
  });

  test("groupLabels is the human label (last path segment)", () => {
    expect(snap.groupLabels[ordOf(snap, "directory:a/x")]).toBe("x");
    expect(snap.groupLabels[ordOf(snap, "directory:b/z")]).toBe("z");
  });
});

describe("buildGroupingSnapshot — directGroupByNode + NO_GROUP", () => {
  test("each node maps to its directly-containing group ordinal", () => {
    const ord = (id: string) => snap.directGroupByNode[nodeIds.indexOf(id)];
    expect(snap.groupIds[ord("a/x/f1.c")]).toBe("directory:a/x");
    expect(snap.groupIds[ord("a/y/f3.c")]).toBe("directory:a/y");
    expect(snap.groupIds[ord("b/z/f6.c")]).toBe("directory:b/z");
  });

  test("a node with no group is NO_GROUP (0xffffffff), not an out-of-range ordinal", () => {
    expect(NO_GROUP).toBe(0xffffffff);
    expect(snap.directGroupByNode[nodeIds.indexOf("top.c")]).toBe(NO_GROUP);
  });

  test("directGroupByNode is one entry per supplied node id, in order", () => {
    expect(snap.directGroupByNode.length).toBe(nodeIds.length);
  });
});

describe("groupPath — ancestor path is derived by walking parentByGroup (NOT stored per node)", () => {
  test("the path of a deep group is outermost-first, including itself", () => {
    // a/x → [a, a/x]
    const o = ordOf(snap, "directory:a/x");
    expect(groupPath(snap, o)).toEqual(["directory:a", "directory:a/x"]);
  });

  test("a root group's path is just itself", () => {
    expect(groupPath(snap, ordOf(snap, "directory:b"))).toEqual(["directory:b"]);
  });

  test("ancestorGroupOrdinals excludes the group itself (strict ancestors, outermost-first)", () => {
    const o = ordOf(snap, "directory:b/z");
    expect(ancestorGroupOrdinals(snap, o)).toEqual([ordOf(snap, "directory:b")]);
    expect(ancestorGroupOrdinals(snap, ordOf(snap, "directory:b"))).toEqual([]);
  });

  test("NO_GROUP has an empty path (no walk)", () => {
    expect(groupPath(snap, NO_GROUP)).toEqual([]);
    expect(ancestorGroupOrdinals(snap, NO_GROUP)).toEqual([]);
  });
});

describe("CompactGroupingSnapshot is JSON / structured-clone round-trippable", () => {
  test("structuredClone preserves every field incl. the typed arrays", () => {
    const clone = structuredClone(snap);
    expect(clone.modeKey).toBe(snap.modeKey);
    expect(clone.groupIds).toEqual(snap.groupIds);
    expect(clone.groupLabels).toEqual(snap.groupLabels);
    expect(clone.boxKeyByGroup).toEqual(snap.boxKeyByGroup);
    expect([...clone.parentByGroup]).toEqual([...snap.parentByGroup]);
    expect([...clone.depthByGroup]).toEqual([...snap.depthByGroup]);
    expect([...clone.directGroupByNode]).toEqual([...snap.directGroupByNode]);
    expect([...clone.roots]).toEqual([...snap.roots]);
    // The clone still answers path queries identically.
    const o = clone.groupIds.indexOf("directory:a/x");
    expect(groupPath(clone, o)).toEqual(["directory:a", "directory:a/x"]);
  });

  test("a JSON round-trip (arrays as plain arrays) rebuilds an equivalent snapshot", () => {
    // Durable workspace copies may be plain JSON — assert the data survives a JSON trip
    // when the typed arrays are reconstructed from their materialized contents.
    const json = JSON.parse(
      JSON.stringify({
        ...snap,
        parentByGroup: [...snap.parentByGroup],
        depthByGroup: [...snap.depthByGroup],
        directGroupByNode: [...snap.directGroupByNode],
        roots: [...snap.roots],
      }),
    );
    const rebuilt: CompactGroupingSnapshot = {
      modeKey: json.modeKey,
      groupIds: json.groupIds,
      groupLabels: json.groupLabels,
      parentByGroup: Int32Array.from(json.parentByGroup),
      depthByGroup: Uint16Array.from(json.depthByGroup),
      boxKeyByGroup: json.boxKeyByGroup,
      directGroupByNode: Uint32Array.from(json.directGroupByNode),
      roots: Uint32Array.from(json.roots),
    };
    expect(rebuilt.groupIds).toEqual(snap.groupIds);
    expect([...rebuilt.directGroupByNode]).toEqual([...snap.directGroupByNode]);
    const o = rebuilt.groupIds.indexOf("directory:a/x");
    expect(groupPath(rebuilt, o)).toEqual(["directory:a", "directory:a/x"]);
  });
});

describe("buildGroupingSnapshot — edge cases", () => {
  test("an empty graph yields an empty snapshot", () => {
    const s = buildGroupingSnapshot(directoryGrouping({ nodes: [], edges: [] }), "directory", []);
    expect(s.groupIds).toEqual([]);
    expect(s.roots.length).toBe(0);
    expect(s.directGroupByNode.length).toBe(0);
  });

  test("a root-only graph (top.c) has no groups; its node is NO_GROUP", () => {
    const g: GraphModel = { nodes: [file("top.c")], edges: [] };
    const s = buildGroupingSnapshot(directoryGrouping(g), "directory", ["top.c"]);
    expect(s.groupIds).toEqual([]);
    expect(s.directGroupByNode[0]).toBe(NO_GROUP);
  });
});
