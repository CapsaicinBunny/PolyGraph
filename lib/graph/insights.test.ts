import { describe, expect, test } from "bun:test";
import { analyzeInsights, type InsightKind, unresolvedToInsights } from "./insights";
import { type GraphModel, type GraphNode, makeEdge } from "./types";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: "file",
  label: id,
  filePath: id,
  line: 0,
  parentFile: id,
  ...extra,
});
const kinds = (g: GraphModel, k: InsightKind) => analyzeInsights(g).filter((i) => i.kind === k);

describe("insights", () => {
  test("detects a circular dependency group", () => {
    const g: GraphModel = {
      nodes: [node("a"), node("b")],
      edges: [makeEdge("a", "b", "import"), makeEdge("b", "a", "import")],
    };
    const cycles = kinds(g, "cycle");
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].nodeIds].sort()).toEqual(["a", "b"]);
  });

  test("detects isolated nodes as one aggregate finding", () => {
    const g: GraphModel = {
      nodes: [node("a"), node("b"), node("lonely")],
      edges: [makeEdge("a", "b", "import")],
    };
    const orphans = kinds(g, "orphan");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].nodeIds).toEqual(["lonely"]);
  });

  test("detects client → server import violations", () => {
    const g: GraphModel = {
      nodes: [node("ui.ts", { environment: "client" }), node("db.ts", { environment: "server" })],
      edges: [makeEdge("ui.ts", "db.ts", "import")],
    };
    expect(kinds(g, "client-server")).toHaveLength(1);
  });

  test("detects undeclared dependencies", () => {
    const g: GraphModel = {
      nodes: [
        node("a.ts"),
        node("external:module:leftpad", {
          kind: "external",
          dependencyType: "undeclared",
          filePath: "",
        }),
      ],
      edges: [makeEdge("a.ts", "external:module:leftpad", "import")],
    };
    expect(kinds(g, "undeclared")).toHaveLength(1);
  });

  test("detects a high fan-in hub", () => {
    const importers = Array.from({ length: 7 }, (_, i) => node(`f${i}.ts`));
    const g: GraphModel = {
      nodes: [node("hub.ts"), ...importers],
      edges: importers.map((f) => makeEdge(f.id, "hub.ts", "import")),
    };
    const fanIn = kinds(g, "fan-in");
    expect(fanIn.some((i) => i.nodeIds[0] === "hub.ts")).toBe(true);
  });

  test("flags an ambiguous resolution from edge evidence", () => {
    const g: GraphModel = {
      nodes: [node("a"), node("b")],
      edges: [
        makeEdge("a", "b", "call", [
          { filePath: "a", line: 1, provider: "TypeScript", confidence: "ambiguous" },
        ]),
      ],
    };
    const amb = kinds(g, "ambiguous");
    expect(amb).toHaveLength(1);
    expect(amb[0].nodeIds).toEqual(["a", "b"]);
  });

  test("turns unresolved references into focusable findings", () => {
    const out = unresolvedToInsights([
      { sourceId: "src/a.ts", name: "./missing", filePath: "src/a.ts", line: 3, column: 8 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("unresolved");
    expect(out[0].nodeIds).toEqual(["src/a.ts"]);
  });

  test("detects a deep dependency chain", () => {
    const chainIds = ["a", "b", "c", "d", "e", "f"];
    const g: GraphModel = {
      nodes: chainIds.map((id) => node(id)),
      edges: chainIds.slice(0, -1).map((id, i) => makeEdge(id, chainIds[i + 1], "import")),
    };
    const deep = kinds(g, "deep-chain");
    expect(deep).toHaveLength(1);
    expect(deep[0].nodeIds).toEqual(chainIds);
    // A short chain does not trigger.
    const short: GraphModel = {
      nodes: [node("x"), node("y")],
      edges: [makeEdge("x", "y", "import")],
    };
    expect(kinds(short, "deep-chain")).toHaveLength(0);
  });
});
