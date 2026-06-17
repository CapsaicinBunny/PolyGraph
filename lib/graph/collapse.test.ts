import { describe, expect, test } from "bun:test";
import { aggregateNodeId, clusterIdOfAggregate, collapseClusters, isAggregateId } from "./collapse";
import { edgeId, type GraphModel } from "./types";

const fileNode = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path.slice(path.lastIndexOf("/") + 1),
  filePath: path,
  line: 0,
  parentFile: path,
});
const symNode = (path: string, sym: string) => ({
  id: `${path}#${sym}`,
  kind: "function" as const,
  label: sym,
  filePath: path,
  line: 1,
  parentFile: path,
});
const edge = (source: string, target: string) => ({
  id: edgeId(source, target, "import"),
  source,
  target,
  kind: "import" as const,
});

const graph: GraphModel = {
  nodes: [
    fileNode("src/a.ts"),
    fileNode("lib/x.ts"),
    fileNode("lib/y.ts"),
    symNode("lib/x.ts", "foo"),
  ],
  edges: [edge("src/a.ts", "lib/x.ts"), edge("lib/x.ts", "lib/y.ts")],
};

describe("collapseClusters", () => {
  test("empty set is a no-op", () => {
    expect(collapseClusters(graph, new Set())).toBe(graph);
  });

  test("collapses a dir's nodes into one aggregate card with a file count", () => {
    const out = collapseClusters(graph, new Set(["lib"]));
    const agg = out.nodes.find((n) => isAggregateId(n.id))!;
    expect(agg.id).toBe(aggregateNodeId("lib"));
    expect(clusterIdOfAggregate(agg.id)).toBe("lib");
    expect(agg.label).toBe("lib · 2"); // x.ts, y.ts — the symbol is not counted
    // lib/* nodes are gone; src/a.ts remains.
    expect(out.nodes.filter((n) => n.id.startsWith("lib/"))).toHaveLength(0);
    expect(out.nodes.some((n) => n.id === "src/a.ts")).toBe(true);
  });

  test("reroutes edges to the aggregate, drops the now-internal one, dedupes", () => {
    const out = collapseClusters(graph, new Set(["lib"]));
    const agg = aggregateNodeId("lib");
    // src/a.ts → lib/x.ts becomes src/a.ts → agg; lib/x.ts → lib/y.ts is internal → dropped.
    expect(out.edges).toEqual([
      { id: edgeId("src/a.ts", agg, "import"), source: "src/a.ts", target: agg, kind: "import" },
    ]);
  });

  test("collapses the «external» cluster (grouped by kind, not path)", () => {
    const extNode = (pkg: string) => ({
      id: `external:module:${pkg}`,
      kind: "external" as const,
      label: pkg,
      filePath: pkg,
      line: 0,
      parentFile: `external:module:${pkg}`,
    });
    const g: GraphModel = {
      nodes: [fileNode("src/a.ts"), extNode("react"), extNode("lodash")],
      edges: [edge("src/a.ts", "external:module:react")],
    };
    const out = collapseClusters(g, new Set(["«external»"]));
    const agg = aggregateNodeId("«external»");
    expect(out.nodes.some((n) => n.id === agg)).toBe(true);
    expect(out.nodes.some((n) => n.kind === "external")).toBe(false);
    expect(out.edges).toEqual([
      { id: edgeId("src/a.ts", agg, "import"), source: "src/a.ts", target: agg, kind: "import" },
    ]);
  });

  test("outermost collapsed ancestor wins when nested dirs both collapse", () => {
    const nested: GraphModel = { nodes: [fileNode("a/b/c.ts")], edges: [] };
    const out = collapseClusters(nested, new Set(["a", "a/b"]));
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].id).toBe(aggregateNodeId("a"));
  });
});
