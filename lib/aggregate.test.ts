import { describe, expect, test } from "bun:test";
import { buildView, fileLevelView, symbolCounts } from "./aggregate";
import type { GraphModel } from "./graph/types";

const graph: GraphModel = {
  nodes: [
    { id: "a.ts", kind: "file", label: "a.ts", filePath: "a.ts", line: 0, parentFile: "a.ts" },
    { id: "b.ts", kind: "file", label: "b.ts", filePath: "b.ts", line: 0, parentFile: "b.ts" },
    {
      id: "a.ts#foo",
      kind: "function",
      label: "foo",
      filePath: "a.ts",
      line: 1,
      parentFile: "a.ts",
    },
    {
      id: "b.ts#bar",
      kind: "function",
      label: "bar",
      filePath: "b.ts",
      line: 1,
      parentFile: "b.ts",
    },
  ],
  edges: [
    {
      id: "a.ts->b.ts:import",
      source: "a.ts",
      target: "b.ts",
      kind: "import",
      occurrences: [],
      count: 0,
    },
    {
      id: "a.ts#foo->b.ts#bar:call",
      source: "a.ts#foo",
      target: "b.ts#bar",
      kind: "call",
      occurrences: [],
      count: 0,
    },
  ],
};

describe("buildView", () => {
  test("collapsed view shows only files and remaps symbol edges to files", () => {
    const view = fileLevelView(graph);
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["a.ts", "b.ts"]);
    // The symbol-level call edge collapses to a file-to-file call edge.
    expect(
      view.edges.some((e) => e.source === "a.ts" && e.target === "b.ts" && e.kind === "call"),
    ).toBe(true);
    expect(view.edges.some((e) => e.kind === "import")).toBe(true);
    expect(view.edges.some((e) => e.kind === "contains")).toBe(false);
  });

  test("expanding one file reveals its symbols with a containment edge", () => {
    const view = buildView(graph, new Set(["a.ts"]));
    expect(view.nodes.some((n) => n.id === "a.ts#foo")).toBe(true);
    expect(view.nodes.some((n) => n.id === "b.ts#bar")).toBe(false);
    expect(
      view.edges.some(
        (e) => e.source === "a.ts" && e.target === "a.ts#foo" && e.kind === "contains",
      ),
    ).toBe(true);
    // foo's call now originates from the symbol; bar's file is collapsed so it targets b.ts.
    expect(
      view.edges.some((e) => e.source === "a.ts#foo" && e.target === "b.ts" && e.kind === "call"),
    ).toBe(true);
  });

  test("expanding both files shows the precise symbol-to-symbol edge", () => {
    const view = buildView(graph, new Set(["a.ts", "b.ts"]));
    expect(
      view.edges.some(
        (e) => e.source === "a.ts#foo" && e.target === "b.ts#bar" && e.kind === "call",
      ),
    ).toBe(true);
  });
});

describe("symbolCounts", () => {
  test("counts symbols per file", () => {
    const counts = symbolCounts(graph);
    expect(counts.get("a.ts")).toBe(1);
    expect(counts.get("b.ts")).toBe(1);
  });
});

describe("buildView evidence merge", () => {
  test("symbol edges collapsing onto one file→file edge merge occurrences + sum counts", () => {
    const ev = (line: number) => ({
      filePath: "a.ts",
      line,
      provider: "TypeScript",
      confidence: "exact" as const,
    });
    const g: GraphModel = {
      nodes: [
        { id: "a.ts", kind: "file", label: "a.ts", filePath: "a.ts", line: 0, parentFile: "a.ts" },
        { id: "b.ts", kind: "file", label: "b.ts", filePath: "b.ts", line: 0, parentFile: "b.ts" },
        {
          id: "a.ts#x",
          kind: "function",
          label: "x",
          filePath: "a.ts",
          line: 1,
          parentFile: "a.ts",
        },
        {
          id: "a.ts#y",
          kind: "function",
          label: "y",
          filePath: "a.ts",
          line: 2,
          parentFile: "a.ts",
        },
        {
          id: "b.ts#m",
          kind: "function",
          label: "m",
          filePath: "b.ts",
          line: 1,
          parentFile: "b.ts",
        },
      ],
      edges: [
        {
          id: "a.ts#x->b.ts#m:call",
          source: "a.ts#x",
          target: "b.ts#m",
          kind: "call",
          occurrences: [ev(10)],
          count: 1,
        },
        {
          id: "a.ts#y->b.ts#m:call",
          source: "a.ts#y",
          target: "b.ts#m",
          kind: "call",
          occurrences: [ev(20)],
          count: 3,
        },
      ],
    };
    // Nothing expanded → both symbol edges collapse to a.ts → b.ts (call).
    const view = buildView(g, new Set());
    const calls = view.edges.filter((e) => e.kind === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0].count).toBe(4); // 1 + 3
    expect(calls[0].occurrences.map((o) => o.line).sort((a, b) => a - b)).toEqual([10, 20]);
    // Both underlying symbol→symbol relationships are tracked on the collapsed edge.
    expect(calls[0].originalEdgeIds.slice().sort()).toEqual([
      "a.ts#x->b.ts#m:call",
      "a.ts#y->b.ts#m:call",
    ]);
  });
});
