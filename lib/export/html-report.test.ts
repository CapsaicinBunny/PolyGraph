import { describe, expect, test } from "bun:test";
import type { Insight } from "../graph/insights";
import { type GraphModel, makeEdge } from "../graph/types";
import { toHTMLReport } from "./html-report";

const node = (id: string, kind = "file") => ({
  id,
  kind: kind as never,
  label: id,
  filePath: id,
  line: 0,
  parentFile: id,
});

const graph: GraphModel = {
  nodes: [node("a.ts"), node("b.ts"), node("a.ts#fn", "function")],
  edges: [makeEdge("a.ts", "b.ts", "import")],
};

const insights: Insight[] = [
  {
    id: "cycle:1",
    kind: "cycle",
    severity: "warning",
    title: "Circular dependency",
    detail: "a → b → a",
    nodeIds: ["a.ts", "b.ts"],
  },
];

describe("toHTMLReport", () => {
  test("produces a standalone document embedding svg, stats, and insights", () => {
    const html = toHTMLReport({
      projectName: "my-proj",
      graph,
      svg: "<svg id='figure'></svg>",
      insights,
      generatedAt: "2026-06-17 12:00",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("my-proj");
    expect(html).toContain("2026-06-17 12:00");
    expect(html).toContain("3 nodes");
    expect(html).toContain("1 relationships");
    expect(html).toContain("2 files");
    expect(html).toContain("<svg id='figure'></svg>"); // embedded as-is
    expect(html).toContain("Circular dependency");
    expect(html).toContain('class="insight warning"');
  });

  test("handles no insights", () => {
    const html = toHTMLReport({
      projectName: "p",
      graph,
      svg: "",
      insights: [],
      generatedAt: "now",
    });
    expect(html).toContain("No architectural issues detected.");
  });

  test("escapes the project name", () => {
    const html = toHTMLReport({
      projectName: "<script>",
      graph,
      svg: "",
      insights: [],
      generatedAt: "now",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<title>PolyGraph report — <script>");
  });
});
