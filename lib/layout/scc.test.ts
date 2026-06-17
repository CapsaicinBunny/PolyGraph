import { describe, expect, test } from "bun:test";
import { stronglyConnectedComponents } from "./scc";

const E = (source: string, target: string) => ({ source, target });

describe("stronglyConnectedComponents", () => {
  test("a 2-cycle is one component", () => {
    const comps = stronglyConnectedComponents(["a", "b"], [E("a", "b"), E("b", "a")]);
    expect(comps).toEqual([{ id: "scc:a|b", members: ["a", "b"] }]);
  });

  test("a 3-cycle is one component", () => {
    const comps = stronglyConnectedComponents(
      ["a", "b", "c"],
      [E("a", "b"), E("b", "c"), E("c", "a")],
    );
    expect(comps.length).toBe(1);
    expect(comps[0].members).toEqual(["a", "b", "c"]);
  });

  test("a DAG yields singletons", () => {
    const comps = stronglyConnectedComponents(["a", "b", "c"], [E("a", "b"), E("b", "c")]);
    expect(comps.map((c) => c.members)).toEqual([["a"], ["b"], ["c"]]);
  });

  test("isolated nodes are singletons", () => {
    const comps = stronglyConnectedComponents(["x", "y"], []);
    expect(comps.map((c) => c.members)).toEqual([["x"], ["y"]]);
  });

  test("self-edges are ignored", () => {
    const comps = stronglyConnectedComponents(["a"], [E("a", "a")]);
    expect(comps).toEqual([{ id: "scc:a", members: ["a"] }]);
  });

  test("mixed: one cycle plus a downstream singleton", () => {
    // a⇄b form a cycle; c hangs off b.
    const comps = stronglyConnectedComponents(
      ["a", "b", "c"],
      [E("a", "b"), E("b", "a"), E("b", "c")],
    );
    expect(comps).toEqual([
      { id: "scc:a|b", members: ["a", "b"] },
      { id: "scc:c", members: ["c"] },
    ]);
  });

  test("is deterministic regardless of input order", () => {
    const a = stronglyConnectedComponents(["c", "a", "b"], [E("b", "c"), E("a", "b"), E("c", "a")]);
    const b = stronglyConnectedComponents(["a", "b", "c"], [E("a", "b"), E("c", "a"), E("b", "c")]);
    expect(a).toEqual(b);
  });
});
