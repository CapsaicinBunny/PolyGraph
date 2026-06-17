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

  test("collapses a community group into one aggregate, rerouting edges", () => {
    // Two files in "Community 1", one outside. The community spans directories,
    // so directory collapse can't express it — only the community map can.
    const communityOf = new Map<string, string>([
      ["src/a.ts", "Community 1"],
      ["lib/x.ts", "Community 1"],
      ["lib/y.ts", "Community 2"],
      ["lib/x.ts#foo", "Community 1"],
    ]);
    const out = collapseClusters(graph, new Set(["Community 1"]), communityOf);
    const agg = aggregateNodeId("Community 1");
    // src/a.ts and lib/x.ts (+ its symbol) fold into the community aggregate.
    expect(out.nodes.some((n) => n.id === agg)).toBe(true);
    expect(out.nodes.some((n) => n.id === "src/a.ts")).toBe(false);
    expect(out.nodes.some((n) => n.id === "lib/x.ts")).toBe(false);
    expect(out.nodes.some((n) => n.id === "lib/x.ts#foo")).toBe(false);
    // lib/y.ts (Community 2, not collapsed) stays.
    expect(out.nodes.some((n) => n.id === "lib/y.ts")).toBe(true);
    // The aggregate counts the two absorbed *file* nodes.
    const aggNode = out.nodes.find((n) => n.id === agg)!;
    expect(aggNode.label).toBe("Community 1 · 2");
    // src/a.ts → lib/x.ts is internal to the community → dropped; lib/x.ts → lib/y.ts
    // reroutes to agg → lib/y.ts.
    expect(out.edges).toEqual([
      {
        id: edgeId(agg, "lib/y.ts", "import"),
        source: agg,
        target: "lib/y.ts",
        kind: "import",
      },
    ]);
  });

  test("directory collapse takes precedence over community membership", () => {
    // lib/x.ts and lib/y.ts are under dir "lib" AND in a community; the dir wins.
    const communityOf = new Map<string, string>([
      ["lib/x.ts", "Community 1"],
      ["lib/y.ts", "Community 1"],
    ]);
    const out = collapseClusters(graph, new Set(["lib"]), communityOf);
    expect(out.nodes.some((n) => n.id === aggregateNodeId("lib"))).toBe(true);
    expect(out.nodes.some((n) => n.id === aggregateNodeId("Community 1"))).toBe(false);
  });

  test("no communityOf leaves community-only members untouched", () => {
    // Without the map, "Community 1" in the collapsed set matches no dir prefix,
    // so the graph is returned unchanged.
    const out = collapseClusters(graph, new Set(["Community 1"]));
    expect(out).toBe(graph);
  });

  test("communityOf present but its id not in the collapsed set is a no-op", () => {
    const communityOf = new Map<string, string>([
      ["src/a.ts", "Community 1"],
      ["lib/x.ts", "Community 1"],
    ]);
    // Collapsing a different community id absorbs nothing.
    const out = collapseClusters(graph, new Set(["Community 2"]), communityOf);
    expect(out).toBe(graph);
  });
});
