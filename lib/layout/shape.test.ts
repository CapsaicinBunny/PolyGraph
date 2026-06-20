import { describe, expect, test } from "bun:test";
import { graphShape } from "./shape";

const E = (source: string, target: string) => ({ source, target });

describe("graphShape", () => {
  test("a tree is acyclic, tree-like, and has no SCCs", () => {
    const s = graphShape(["r", "a", "b", "c"], [E("r", "a"), E("r", "b"), E("a", "c")]);
    expect(s.nodeCount).toBe(4);
    expect(s.edgeCount).toBe(3);
    expect(s.componentCount).toBe(1);
    expect(s.sccNodeRatio).toBe(0);
    expect(s.dagScore).toBe(1);
    expect(s.treeScore).toBeGreaterThan(0.9);
  });

  test("a 3-cycle is fully cyclic", () => {
    const s = graphShape(["a", "b", "c"], [E("a", "b"), E("b", "c"), E("c", "a")]);
    expect(s.sccNodeRatio).toBe(1);
    expect(s.dagScore).toBeLessThan(0.5);
  });

  test("a star has high degree inequality and a hub", () => {
    const star = graphShape(
      ["h", "a", "b", "c", "d"],
      [E("h", "a"), E("h", "b"), E("h", "c"), E("h", "d")],
    );
    const path = graphShape(
      ["a", "b", "c", "d", "e"],
      [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")],
    );
    expect(star.degreeGini).toBeGreaterThan(path.degreeGini);
    expect(star.hubRatio).toBeGreaterThan(0);
    expect(star.leafRatio).toBeGreaterThan(0.5); // the four spokes are leaves
  });

  test("isolates and components are counted", () => {
    const s = graphShape(["a", "b", "x"], [E("a", "b")]);
    expect(s.componentCount).toBe(2);
    expect(s.isolateRatio).toBeCloseTo(1 / 3, 5);
  });

  test("is deterministic regardless of input order", () => {
    const a = graphShape(["c", "a", "b"], [E("b", "c"), E("a", "b")]);
    const b = graphShape(["a", "b", "c"], [E("a", "b"), E("b", "c")]);
    expect(a).toEqual(b);
  });
});

describe("graphShape modularity", () => {
  test("high for clear community structure, low for a clique", () => {
    // Two triangles joined by one bridge → strong communities.
    const bridged = graphShape(
      ["a", "b", "c", "d", "e", "f"],
      [E("a", "b"), E("b", "c"), E("c", "a"), E("d", "e"), E("e", "f"), E("f", "d"), E("c", "d")],
    );
    expect(bridged.modularity).toBeGreaterThan(0.3);
    expect(bridged.largestCommunityRatio).toBeLessThanOrEqual(0.5);

    // A 4-clique has no community structure → modularity near 0.
    const ids = ["p", "q", "r", "s"];
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) edges.push(E(ids[i], ids[j]));
    expect(graphShape(ids, edges).modularity).toBeLessThan(0.3);
  });
});
