import { describe, expect, test } from "bun:test";
import { buildArborescence, treeScore } from "./tree";

const E = (source: string, target: string, weight?: number) => ({ source, target, weight });

describe("buildArborescence", () => {
  test("recovers parents of a directed tree", () => {
    const { parent, roots } = buildArborescence(
      ["r", "a", "b", "c"],
      [E("r", "a"), E("r", "b"), E("a", "c")],
    );
    expect(roots).toEqual(["r"]);
    expect(parent.get("r")).toBeNull();
    expect(parent.get("a")).toBe("r");
    expect(parent.get("b")).toBe("r");
    expect(parent.get("c")).toBe("a");
  });

  test("picks the maximum-weight parent when a node has several", () => {
    // x can hang off p (weak) or q (strong); the strong architectural edge wins.
    const { parent } = buildArborescence(
      ["root", "p", "q", "x"],
      [E("root", "p"), E("root", "q"), E("p", "x", 1), E("q", "x", 8)],
    );
    expect(parent.get("x")).toBe("q");
  });

  test("produces an acyclic parent map even with cycles in the graph", () => {
    // a→b→c→a plus a root r→a. Following parents from any node must reach a root.
    const { parent, roots } = buildArborescence(
      ["r", "a", "b", "c"],
      [E("r", "a"), E("a", "b"), E("b", "c"), E("c", "a")],
    );
    for (const start of ["a", "b", "c"]) {
      const seen = new Set<string>();
      let cur: string | null | undefined = start;
      while (cur != null) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = parent.get(cur);
      }
      expect(roots).toContain([...seen].pop()!);
    }
  });

  test("is deterministic regardless of input order", () => {
    const a = buildArborescence(["c", "a", "r", "b"], [E("a", "c"), E("r", "a"), E("r", "b")]);
    const b = buildArborescence(["r", "a", "b", "c"], [E("r", "b"), E("r", "a"), E("a", "c")]);
    expect([...a.parent.entries()].sort()).toEqual([...b.parent.entries()].sort());
  });
});

describe("treeScore", () => {
  test("is 1 for a perfect tree", () => {
    expect(treeScore(["r", "a", "b", "c"], [E("r", "a"), E("r", "b"), E("a", "c")])).toBeCloseTo(
      1,
      5,
    );
  });

  test("is lower for a merge-heavy DAG than for a tree", () => {
    const tree = treeScore(["r", "a", "b", "c"], [E("r", "a"), E("r", "b"), E("a", "c")]);
    // Diamond: d has two parents → less tree-like.
    const diamond = treeScore(
      ["a", "b", "c", "d"],
      [E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d")],
    );
    expect(diamond).toBeLessThan(tree);
  });
});
