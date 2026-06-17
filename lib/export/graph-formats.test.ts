import { describe, expect, test } from "bun:test";
import { type GraphModel, makeEdge } from "../graph/types";
import { toDOT, toGraphML, toMermaid, toPolyGraphJSON } from "./graph-formats";

const node = (id: string, label: string, kind = "file", filePath = id, line = 0) => ({
  id,
  kind: kind as never,
  label,
  filePath,
  line,
  parentFile: filePath,
});

// a → b (import), with a quote in a label to exercise escaping.
const graph: GraphModel = {
  nodes: [node("src/a.ts", 'a "x"'), node("src/b.ts", "b")],
  edges: [makeEdge("src/a.ts", "src/b.ts", "import")],
};

describe("toDOT", () => {
  test("emits a digraph with escaped labels and edges", () => {
    const dot = toDOT(graph);
    expect(dot).toContain("digraph PolyGraph {");
    expect(dot).toContain("rankdir=LR;");
    expect(dot).toContain('"src/a.ts" [label="a \\"x\\""];');
    expect(dot).toContain('"src/a.ts" -> "src/b.ts" [label="import"];');
    expect(dot.trimEnd().endsWith("}")).toBe(true);
  });

  test("honors rankdir", () => {
    expect(toDOT(graph, "TB")).toContain("rankdir=TB;");
  });
});

describe("toGraphML", () => {
  test("emits valid-shaped XML with node data and escaped text", () => {
    const xml = toGraphML(graph);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<graph edgedefault="directed">');
    expect(xml).toContain('<node id="src/a.ts">');
    expect(xml).toContain('<data key="label">a &quot;x&quot;</data>');
    expect(xml).toContain('<edge source="src/a.ts" target="src/b.ts">');
    expect(xml).toContain("</graphml>");
  });
});

describe("toMermaid", () => {
  test("remaps ids to aliases and sanitizes labels", () => {
    const mer = toMermaid(graph);
    expect(mer.startsWith("graph LR")).toBe(true);
    expect(mer).toContain('n0["a x"]'); // quote stripped from label
    expect(mer).toContain("n0 -->|import| n1");
  });

  test("honors direction", () => {
    expect(toMermaid(graph, "TB").startsWith("graph TB")).toBe(true);
  });
});

describe("toPolyGraphJSON", () => {
  test("round-trips the model", () => {
    const parsed = JSON.parse(toPolyGraphJSON(graph)) as GraphModel;
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges[0].source).toBe("src/a.ts");
  });
});
