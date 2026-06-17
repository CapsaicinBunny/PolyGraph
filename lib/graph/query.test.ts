import { describe, expect, test } from "bun:test";
import {
  blastRadius,
  dependencies,
  dependents,
  neighborhood,
  shortestPath,
  whyConnected,
} from "./query";
import { type EdgeKind, type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a → b → c ; a → d ; e is isolated.
const graph: GraphModel = {
  nodes: [file("pkg/a.ts"), file("pkg/b.ts"), file("pkg/c.ts"), file("lib/d.ts"), file("pkg/e.ts")],
  edges: [
    makeEdge("pkg/a.ts", "pkg/b.ts", "import"),
    makeEdge("pkg/b.ts", "pkg/c.ts", "import"),
    makeEdge("pkg/a.ts", "lib/d.ts", "import"),
  ],
};

describe("graph queries", () => {
  test("dependencies follows outgoing edges transitively", () => {
    expect([...dependencies(graph, "pkg/a.ts")].sort()).toEqual([
      "lib/d.ts",
      "pkg/b.ts",
      "pkg/c.ts",
    ]);
    expect([...dependencies(graph, "pkg/a.ts", 1)].sort()).toEqual(["lib/d.ts", "pkg/b.ts"]);
  });

  test("dependents follows incoming edges (impact)", () => {
    expect([...dependents(graph, "pkg/c.ts")].sort()).toEqual(["pkg/a.ts", "pkg/b.ts"]);
    expect([...dependents(graph, "pkg/e.ts")]).toEqual([]); // orphan affects nothing
  });

  test("neighborhood is undirected to N hops and includes the center", () => {
    expect([...neighborhood(graph, "pkg/b.ts", 1)].sort()).toEqual([
      "pkg/a.ts",
      "pkg/b.ts",
      "pkg/c.ts",
    ]);
  });

  test("shortestPath returns the directed path or null", () => {
    expect(shortestPath(graph, "pkg/a.ts", "pkg/c.ts")).toEqual([
      "pkg/a.ts",
      "pkg/b.ts",
      "pkg/c.ts",
    ]);
    expect(shortestPath(graph, "pkg/c.ts", "pkg/a.ts")).toBeNull(); // directed
  });

  test("whyConnected returns the path + connecting edge kinds", () => {
    const conn = whyConnected(graph, "pkg/a.ts", "pkg/c.ts");
    expect(conn?.path).toEqual(["pkg/a.ts", "pkg/b.ts", "pkg/c.ts"]);
    expect(conn?.edges.map((e) => e.kind as EdgeKind)).toEqual(["import", "import"]);
  });

  test("blastRadius groups affected nodes by package, file, and kind", () => {
    const br = blastRadius(graph, "pkg/c.ts");
    expect(br.total).toBe(2); // a, b
    expect(br.byPackage.pkg).toBe(2);
    expect(br.byKind.import).toBeGreaterThanOrEqual(1);
  });
});
