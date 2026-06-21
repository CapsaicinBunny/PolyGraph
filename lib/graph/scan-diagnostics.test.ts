import { describe, expect, test } from "bun:test";
import { type DimensionCatalog, STRUCTURAL_DESCRIPTORS } from "./dimensions";
import { hasIntegrityIssue, scanDiagnostics } from "./scan-diagnostics";
import { type GraphModel, type GraphNode, makeEdge } from "./types";

function file(id: string, facets?: Record<string, string[]>): GraphNode {
  return {
    id,
    kind: "file",
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
    ...(facets ? { facets } : {}),
  };
}
const provider = [{ filePath: "a.ts", line: 1, provider: "ts", confidence: "exact" as const }];

describe("scanDiagnostics", () => {
  test("reports shape: counts, kinds, externals, catalog reach", () => {
    const graph: GraphModel = {
      nodes: [
        file("a.ts"),
        {
          id: "ext",
          kind: "external",
          label: "react",
          filePath: "",
          line: 0,
          parentFile: "ext",
          externalKind: "npm",
        },
      ],
      edges: [makeEdge("a.ts", "ext", "import", provider)],
    };
    const catalog: DimensionCatalog = { descriptors: [...STRUCTURAL_DESCRIPTORS] };
    const d = scanDiagnostics(graph, catalog);
    expect(d.nodes).toBe(2);
    expect(d.edges).toBe(1);
    expect(d.externals).toBe(1);
    expect(d.byKind).toEqual({ file: 1, external: 1 });
    expect(d.dimensions).toBe(STRUCTURAL_DESCRIPTORS.length);
    expect(d.dimensionKeys).toContain("kind");
    expect(hasIntegrityIssue(d)).toBe(false);
  });

  test("flags null/empty facet values (the scan-crash signature)", () => {
    const graph: GraphModel = {
      nodes: [file("a.ts", { runtime: [null as unknown as string] }), file("b.ts", { env: [""] })],
      edges: [],
    };
    const d = scanDiagnostics(graph);
    expect(d.integrity.nullOrEmptyFacetValues).toBe(2);
    expect(d.integrity.facetKeysWithBadValue.sort()).toEqual(["env", "runtime"]);
    expect(hasIntegrityIssue(d)).toBe(true);
    expect(d.dimensions).toBe(0); // no catalog passed → the TS-only fallback is in play
  });

  test("flags dangling edges (a target/source absent from the node set)", () => {
    const graph: GraphModel = {
      nodes: [file("a.ts")],
      edges: [makeEdge("a.ts", "missing.ts", "import", provider)],
    };
    const d = scanDiagnostics(graph);
    expect(d.integrity.danglingEdges).toBe(1);
    expect(hasIntegrityIssue(d)).toBe(true);
  });
});
