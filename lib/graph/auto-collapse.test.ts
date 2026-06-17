import { describe, expect, test } from "bun:test";
import { autoCollapseDirs } from "./auto-collapse";
import { collapseClusters } from "./collapse";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6} — 6 files; depth-1 dirs {a,b}, depth-2 {a/x,a/y,b/z}.
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/y/f3.c"),
    file("b/z/f4.c"),
    file("b/z/f5.c"),
    file("b/z/f6.c"),
  ],
  edges: [],
};

describe("autoCollapseDirs", () => {
  test("returns null when the graph already fits", () => {
    expect(autoCollapseDirs(graph, 10)).toBeNull();
  });

  test("collapses to top-level dirs under a tight budget", () => {
    const r = autoCollapseDirs(graph, 2)!;
    expect(r.depth).toBe(1);
    expect([...r.collapsed].sort()).toEqual(["a", "b"]);
    expect(r.renderedEstimate).toBe(2);
  });

  test("picks the deepest depth that still fits the budget", () => {
    const r = autoCollapseDirs(graph, 3)!;
    expect(r.depth).toBe(2);
    expect([...r.collapsed].sort()).toEqual(["a/x", "a/y", "b/z"]);
    expect(r.renderedEstimate).toBe(3);
  });

  test("chosen collapse keys actually reduce the graph to the estimate", () => {
    const r = autoCollapseDirs(graph, 2)!;
    const collapsed = collapseClusters(graph, r.collapsed);
    expect(collapsed.nodes).toHaveLength(r.renderedEstimate); // 2 aggregate cards
  });

  test("root-level files that no directory absorbs are counted (falls back to depth 1)", () => {
    const g: GraphModel = { nodes: [...graph.nodes, file("top.c")], edges: [] };
    const r = autoCollapseDirs(g, 2)!;
    expect(r.depth).toBe(1); // even depth-1 overflows (2 dirs + 1 root file = 3) → coarsest
    expect(r.renderedEstimate).toBe(3);
    // top.c is not under a/b, so it survives alongside the two aggregates.
    expect(collapseClusters(g, r.collapsed).nodes).toHaveLength(3);
  });
});
