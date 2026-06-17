import { describe, expect, test } from "bun:test";
import { type EdgeEvidence, type GraphModel, makeEdge } from "./types";
import { trimEdgeOccurrences, trimIfLarge } from "./trim";

const ev = (line: number): EdgeEvidence => ({
  filePath: "a.ts",
  line,
  provider: "TypeScript",
  confidence: "exact",
});

const node = (id: string) => ({
  id,
  kind: "file" as const,
  label: id,
  filePath: id,
  line: 0,
  parentFile: id,
});

function graphWith(occCount: number, nodeCount = 1): GraphModel {
  const edge = makeEdge(
    "a.ts",
    "b.ts",
    "call",
    Array.from({ length: occCount }, (_, i) => ev(i + 1)),
  );
  edge.count = 12; // exact total may exceed retained occurrences
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => node(`n${i}.ts`)),
    edges: [edge],
  };
}

describe("trimEdgeOccurrences", () => {
  test("slices occurrences but preserves count", () => {
    const trimmed = trimEdgeOccurrences(graphWith(10), 1);
    expect(trimmed.edges[0].occurrences).toHaveLength(1);
    expect(trimmed.edges[0].count).toBe(12); // count untouched
  });

  test("returns the same object when nothing exceeds the cap", () => {
    const g = graphWith(1);
    expect(trimEdgeOccurrences(g, 1)).toBe(g); // identity, no copy
  });
});

describe("trimIfLarge", () => {
  test("leaves small graphs untouched (identity)", () => {
    const g = graphWith(10, 5);
    expect(trimIfLarge(g, 20000, 1)).toBe(g);
    expect(g.edges[0].occurrences).toHaveLength(10);
  });

  test("trims when the node count exceeds the threshold", () => {
    const g = graphWith(10, 50);
    const trimmed = trimIfLarge(g, 10, 1);
    expect(trimmed).not.toBe(g);
    expect(trimmed.edges[0].occurrences).toHaveLength(1);
    expect(trimmed.edges[0].count).toBe(12);
  });
});
