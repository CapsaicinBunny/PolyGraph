import { describe, expect, test } from "bun:test";
import { type GraphModel, makeEdge } from "../graph/types";
import { buildStatusMap, diffGraphs } from "./diff";

const file = (path: string, extra: Record<string, unknown> = {}) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
  ...extra,
});

describe("diffGraphs — node/edge deltas", () => {
  const before: GraphModel = {
    nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
    edges: [makeEdge("a.ts", "b.ts", "import"), makeEdge("b.ts", "c.ts", "import")],
  };
  // remove c, add d & e; add edges a→d, d→e; drop b→c.
  const after: GraphModel = {
    nodes: [file("a.ts"), file("b.ts"), file("d.ts"), file("e.ts")],
    edges: [
      makeEdge("a.ts", "b.ts", "import"),
      makeEdge("a.ts", "d.ts", "import"),
      makeEdge("d.ts", "e.ts", "import"),
    ],
  };

  test("classifies added/removed nodes and edges", () => {
    const d = diffGraphs(before, after, "main", "HEAD");
    expect(d.base).toBe("main");
    expect(d.head).toBe("HEAD");
    expect(d.nodes.added.map((n) => n.id).sort()).toEqual(["d.ts", "e.ts"]);
    expect(d.nodes.removed.map((n) => n.id)).toEqual(["c.ts"]);
    expect(d.summary.edgesAdded).toBe(2); // a→d, d→e
    expect(d.summary.edgesRemoved).toBe(1); // b→c
    expect(d.edges.unchangedCount).toBe(1); // a→b
  });

  test("unchanged nodes counted, not listed", () => {
    const d = diffGraphs(before, after);
    expect(d.nodes.unchangedCount).toBe(2); // a, b
  });
});

describe("diffGraphs — changed node attributes", () => {
  test("same id with a changed field is a NodeChange", () => {
    const before: GraphModel = {
      nodes: [file("x.ts#C", { kind: "function", parentFile: "x.ts" })],
      edges: [],
    };
    const after: GraphModel = {
      nodes: [file("x.ts#C", { kind: "component", parentFile: "x.ts" })],
      edges: [],
    };
    const d = diffGraphs(before, after);
    expect(d.nodes.changed).toHaveLength(1);
    expect(d.nodes.changed[0].fields).toContain("kind");
    expect(d.summary.nodesChanged).toBe(1);
  });
});

describe("diffGraphs — cycles", () => {
  test("detects a newly introduced cycle", () => {
    const before: GraphModel = {
      nodes: [file("a.ts"), file("b.ts")],
      edges: [makeEdge("a.ts", "b.ts", "import")],
    };
    const after: GraphModel = {
      nodes: [file("a.ts"), file("b.ts")],
      edges: [makeEdge("a.ts", "b.ts", "import"), makeEdge("b.ts", "a.ts", "import")],
    };
    const d = diffGraphs(before, after);
    expect(d.summary.newCycles).toBe(1);
    expect(d.newCycles[0].labels.sort()).toEqual(["a.ts", "b.ts"]);
    expect(d.summary.removedCycles).toBe(0);
  });

  test("detects a removed cycle", () => {
    const cyclic: GraphModel = {
      nodes: [file("a.ts"), file("b.ts")],
      edges: [makeEdge("a.ts", "b.ts", "import"), makeEdge("b.ts", "a.ts", "import")],
    };
    const acyclic: GraphModel = {
      nodes: [file("a.ts"), file("b.ts")],
      edges: [makeEdge("a.ts", "b.ts", "import")],
    };
    const d = diffGraphs(cyclic, acyclic);
    expect(d.summary.removedCycles).toBe(1);
    expect(d.summary.newCycles).toBe(0);
  });
});

describe("diffGraphs — blast radius deltas", () => {
  test("reports a node whose dependents grew", () => {
    // before: only b depends on svc. after: b and c depend on svc → +100%.
    const before: GraphModel = {
      nodes: [file("svc.ts"), file("b.ts"), file("c.ts")],
      edges: [makeEdge("b.ts", "svc.ts", "import")],
    };
    const after: GraphModel = {
      nodes: [file("svc.ts"), file("b.ts"), file("c.ts")],
      edges: [makeEdge("b.ts", "svc.ts", "import"), makeEdge("c.ts", "svc.ts", "import")],
    };
    const d = diffGraphs(before, after);
    const svc = d.blastRadiusDeltas.find((x) => x.id === "svc.ts");
    expect(svc).toBeDefined();
    expect(svc?.before).toBe(1);
    expect(svc?.after).toBe(2);
    expect(svc?.pctChange).toBe(100);
  });
});

describe("buildStatusMap", () => {
  test("maps ids to their change status", () => {
    const before: GraphModel = { nodes: [file("a.ts"), file("c.ts")], edges: [] };
    const after: GraphModel = { nodes: [file("a.ts"), file("d.ts")], edges: [] };
    const status = buildStatusMap(diffGraphs(before, after));
    expect(status.get("d.ts")).toBe("added");
    expect(status.get("c.ts")).toBe("removed");
    expect(status.get("a.ts")).toBeUndefined(); // unchanged → not in map
  });
});
