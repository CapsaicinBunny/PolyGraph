import { describe, expect, test } from "bun:test";
import { buildDirTree, dirIndex, dirOf } from "./hierarchy";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

describe("dirOf", () => {
  test("returns the containing directory, or '' for root files", () => {
    expect(dirOf("a/b/c.ts")).toBe("a/b");
    expect(dirOf("top.ts")).toBe("");
  });
});

describe("buildDirTree", () => {
  // a/x/{f1,f2}, a/y/f3, b/z/f4, top.c (root)
  const graph: GraphModel = {
    nodes: [
      file("a/x/f1.c"),
      file("a/x/f2.c"),
      file("a/y/f3.c"),
      file("b/z/f4.c"),
      file("top.c"),
      // a symbol node — must be ignored by the tree (only file nodes count).
      { ...file("a/x/f1.c#sym"), kind: "function", parentFile: "a/x/f1.c" },
    ],
    edges: [],
  };

  test("roots the tree and counts subtree files", () => {
    const root = buildDirTree(graph);
    expect(root.path).toBe("");
    expect(root.totalFiles).toBe(5); // all files incl. the root file, symbols excluded
    expect(root.files).toEqual(["top.c"]); // direct root file
    const a = root.children.find((c) => c.path === "a")!;
    expect(a.totalFiles).toBe(3); // a/x/f1, a/x/f2, a/y/f3
    expect(a.depth).toBe(1);
  });

  test("children are sorted heaviest subtree first", () => {
    const root = buildDirTree(graph);
    // a (3 files) before b (1 file); 'top.c' is a direct file, not a child dir.
    expect(root.children.map((c) => c.name)).toEqual(["a", "b"]);
    const a = root.children.find((c) => c.path === "a")!;
    expect(a.children.map((c) => c.name)).toEqual(["x", "y"]); // x has 2, y has 1
  });

  test("dirIndex maps every directory path (excluding root)", () => {
    const index = dirIndex(buildDirTree(graph));
    expect([...index.keys()].sort()).toEqual(["a", "a/x", "a/y", "b", "b/z"]);
    expect(index.get("a/x")!.files.sort()).toEqual(["a/x/f1.c", "a/x/f2.c"]);
    expect(index.get("a/x")!.depth).toBe(2);
  });

  test("handles an empty graph", () => {
    const root = buildDirTree({ nodes: [], edges: [] });
    expect(root.totalFiles).toBe(0);
    expect(root.children).toEqual([]);
  });
});
