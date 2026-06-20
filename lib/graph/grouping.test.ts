import { describe, expect, test } from "bun:test";
import { directoryGrouping, type GroupingHierarchy } from "./grouping";
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

const h: GroupingHierarchy = directoryGrouping(graph);
const sorted = (ids: string[]) => [...ids].sort();

describe("directoryGrouping — namespaced group ids", () => {
  test("roots() returns the top-level directories as namespaced ids", () => {
    expect(sorted(h.roots())).toEqual(["directory:a", "directory:b"]);
  });

  test("childrenOf walks one directory level down, namespaced", () => {
    expect(sorted(h.childrenOf("directory:a"))).toEqual(["directory:a/x", "directory:a/y"]);
    expect(sorted(h.childrenOf("directory:b"))).toEqual(["directory:b/z"]);
  });

  test("childrenOf a leaf directory is empty", () => {
    expect(h.childrenOf("directory:a/x")).toEqual([]);
  });

  test("childrenOf an unknown id is empty (not a throw)", () => {
    expect(h.childrenOf("directory:does/not/exist")).toEqual([]);
  });
});

describe("directoryGrouping — node membership", () => {
  test("nodesOf returns the file ids directly in a directory (not its subdirs)", () => {
    expect(sorted(h.nodesOf("directory:a/x"))).toEqual(["a/x/f1.c", "a/x/f2.c"]);
    expect(sorted(h.nodesOf("directory:b/z"))).toEqual(["b/z/f4.c", "b/z/f5.c", "b/z/f6.c"]);
  });

  test("nodesOf an intermediate directory with no direct files is empty", () => {
    // "a" holds no direct files — only the subdirs a/x and a/y do.
    expect(h.nodesOf("directory:a")).toEqual([]);
  });

  test("groupOfNode maps a file to its directly-containing directory group", () => {
    expect(h.groupOfNode("a/x/f1.c")).toBe("directory:a/x");
    expect(h.groupOfNode("b/z/f6.c")).toBe("directory:b/z");
  });

  test("groupOfNode returns null for a root-level file (no directory group)", () => {
    expect(h.groupOfNode("top.c")).toBeNull();
  });

  test("groupOfNode returns null for an unknown node id", () => {
    expect(h.groupOfNode("nope/missing.c")).toBeNull();
  });
});

describe("directoryGrouping — boxKey is the LOD contract", () => {
  // boxKey MUST return the bare path the layout's ClusterBox id uses (and that
  // sceneBoxes()/computeCut measure against), so the namespaced group id round-trips
  // to the exact key the existing collapse/LOD machinery already keys on.
  test("boxKey strips the directory: namespace to the bare path", () => {
    expect(h.boxKey("directory:a")).toBe("a");
    expect(h.boxKey("directory:a/x")).toBe("a/x");
    expect(h.boxKey("directory:b/z")).toBe("b/z");
  });

  test("every root and child boxKey matches a bare directory path", () => {
    for (const root of h.roots()) {
      expect(h.boxKey(root)).toBe(root.slice("directory:".length));
      for (const child of h.childrenOf(root)) {
        expect(h.boxKey(child)).toBe(child.slice("directory:".length));
      }
    }
  });
});

describe("directoryGrouping — edge cases", () => {
  test("an empty graph has no roots", () => {
    const empty = directoryGrouping({ nodes: [], edges: [] });
    expect(empty.roots()).toEqual([]);
  });

  test("symbol nodes are ignored — only file nodes drive directory membership", () => {
    const g: GraphModel = {
      nodes: [
        file("a/f.c"),
        {
          id: "a/f.c#sym",
          kind: "function",
          label: "sym",
          filePath: "a/f.c",
          line: 1,
          parentFile: "a/f.c",
        },
      ],
      edges: [],
    };
    const gh = directoryGrouping(g);
    expect(gh.roots()).toEqual(["directory:a"]);
    expect(gh.nodesOf("directory:a")).toEqual(["a/f.c"]); // the symbol is not a directory member
    expect(gh.groupOfNode("a/f.c#sym")).toBeNull(); // symbols have no directory group of their own
  });
});
