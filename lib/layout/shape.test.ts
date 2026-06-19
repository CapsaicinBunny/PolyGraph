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
    const path = graphShape(["a", "b", "c", "d", "e"], [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")]);
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
