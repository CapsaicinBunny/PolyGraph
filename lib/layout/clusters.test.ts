import { describe, expect, test } from "bun:test";
import { buildClusterTree } from "./clusters";

const N = (id: string, kind = "file") => ({ id, kind });

describe("buildClusterTree", () => {
  test("nests files under their directory clusters", () => {
    const { root, ancestry } = buildClusterTree([
      N("a/b/f.ts"),
      N("a/b/f.ts#x", "function"),
      N("a/c/g.ts"),
    ]);
    const a = root.children.get("a")!;
    expect(a).toBeTruthy();
    expect([...a.children.keys()].sort()).toEqual(["b", "c"]);
    expect(a.children.get("b")!.nodeIds.sort()).toEqual(["a/b/f.ts", "a/b/f.ts#x"]);
    expect(ancestry.get("a/c/g.ts")).toEqual(["a", "a/c"]);
  });

  test("compresses single-child chains into one labelled box", () => {
    const { root } = buildClusterTree([N("src/lib/graph/x.ts")]);
    const top = root.children.get("src")!;
    expect(top.id).toBe("src/lib/graph");
    expect(top.label).toBe("src/lib/graph");
    expect(top.children.size).toBe(0);
    expect(top.nodeIds).toEqual(["src/lib/graph/x.ts"]);
  });

  test("repo-root files belong to the root cluster", () => {
    const { root, ancestry } = buildClusterTree([N("README.md")]);
    expect(root.nodeIds).toEqual(["README.md"]);
    expect(ancestry.get("README.md")).toEqual([]);
  });

  test("external nodes group under one synthetic cluster", () => {
    const { root } = buildClusterTree([N("react", "external"), N("a/f.ts")]);
    expect(root.children.has("«external»")).toBe(true);
    expect(root.children.get("«external»")!.nodeIds).toEqual(["react"]);
  });
});
