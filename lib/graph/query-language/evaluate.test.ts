import { describe, expect, test } from "bun:test";
import { type GraphModel, type GraphNode, makeEdge } from "../types";
import { runQuery } from "./evaluate";

const sym = (filePath: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: `${filePath}#${name}`,
  kind: "function",
  label: name,
  filePath,
  line: 1,
  parentFile: filePath,
  ...extra,
});

const n1 = sym("src/api/users.ts", "listUsers", { kind: "function", environment: "server" });
const n2 = sym("src/api/users.ts", "getUser", { kind: "function", environment: "server" });
const n3 = sym("app/page.tsx", "Page", {
  kind: "component",
  role: "react-component",
  environment: "client",
});
const n4: GraphNode = {
  id: "external:database",
  kind: "external",
  label: "database",
  filePath: "",
  line: 0,
  parentFile: "external:database",
  externalKind: "npm",
  dependencyType: "dependency",
};
const n5 = sym("lib/a.ts", "A", { kind: "class" });
const n6 = sym("lib/b.ts", "B", { kind: "class" });

// n3 calls n1,n2 ; n5,n6 call n1 ; n1 imports database ; n5<->n6 cycle.
const graph: GraphModel = {
  nodes: [n1, n2, n3, n4, n5, n6],
  edges: [
    makeEdge(n3.id, n1.id, "call"),
    makeEdge(n3.id, n2.id, "call"),
    makeEdge(n5.id, n1.id, "call"),
    makeEdge(n6.id, n1.id, "call"),
    makeEdge(n1.id, n4.id, "import"),
    makeEdge(n5.id, n6.id, "call"),
    makeEdge(n6.id, n5.id, "call"),
  ],
};

const ids = (q: string) => [...runQuery(graph, q).nodeIds].sort();

describe("runQuery — fields", () => {
  test("kind", () => {
    expect(ids("kind:function")).toEqual([n1.id, n2.id].sort());
    expect(ids("kind:class")).toEqual([n5.id, n6.id].sort());
  });

  test("language with alias", () => {
    expect(ids("language:tsx")).toEqual([n3.id]);
    expect(ids("lang:rust")).toEqual([]);
  });

  test("path glob", () => {
    expect(ids("path:src/api/**")).toEqual([n1.id, n2.id].sort());
    expect(ids("path:app/*.tsx")).toEqual([n3.id]);
  });

  test("environment", () => {
    expect(ids("environment:server")).toEqual([n1.id, n2.id].sort());
    expect(ids("env:client")).toEqual([n3.id]);
  });

  test("role", () => {
    expect(ids("role:react-component")).toEqual([n3.id]);
  });

  test("dependency-type", () => {
    expect(ids("dep:dependency")).toEqual([n4.id]);
    expect(ids("dependency-type:prod")).toEqual([n4.id]);
  });

  test("numeric: calls / incoming / outgoing", () => {
    expect(ids("calls:>1")).toEqual([n3.id, n5.id, n6.id].sort()); // each makes 2 calls
    expect(ids("incoming:>2")).toEqual([n1.id]); // n1 has 3 incoming
    expect(ids("incoming:=0")).toContain(n3.id);
  });

  test("cycle membership", () => {
    expect(ids("cycle:true")).toEqual([n5.id, n6.id].sort());
  });

  test("depends-on is transitive (reverse reachability)", () => {
    const r = ids('depends-on:"database"');
    expect(r).toContain(n1.id); // imports it directly
    expect(r).toContain(n3.id); // calls n1 which imports it
    expect(r).not.toContain(n4.id); // the target itself is excluded
  });

  test("bare text matches label or path", () => {
    expect(ids("user")).toEqual([n1.id, n2.id].sort());
  });
});

describe("runQuery — boolean ops", () => {
  test("implicit AND", () => {
    expect(ids("kind:function environment:server")).toEqual([n1.id, n2.id].sort());
    expect(ids("path:src/api/** incoming:>2")).toEqual([n1.id]);
  });

  test("OR", () => {
    expect(ids("kind:class | role:react-component")).toEqual([n3.id, n5.id, n6.id].sort());
  });

  test("NOT", () => {
    expect(ids("-kind:function")).toEqual([n3.id, n4.id, n5.id, n6.id].sort());
  });
});

describe("runQuery — path / flow", () => {
  test("client -> server selects boundary-crossing edges", () => {
    const r = runQuery(graph, "environment:client -> environment:server");
    expect([...r.nodeIds].sort()).toEqual([n1.id, n2.id, n3.id].sort());
    expect(r.edgeIds.has(makeEdge(n3.id, n1.id, "call").id)).toBe(true);
    expect(r.edgeIds.has(makeEdge(n3.id, n2.id, "call").id)).toBe(true);
    expect(r.edgeIds.has(makeEdge(n5.id, n1.id, "call").id)).toBe(false);
  });
});

describe("runQuery — induced edges + errors + empty", () => {
  test("node query emits induced edges", () => {
    const r = runQuery(graph, "kind:class");
    // n5<->n6 both selected -> both edges induced.
    expect(r.edgeIds.has(makeEdge(n5.id, n6.id, "call").id)).toBe(true);
    expect(r.edgeIds.has(makeEdge(n6.id, n5.id, "call").id)).toBe(true);
    expect(r.edgeIds.has(makeEdge(n5.id, n1.id, "call").id)).toBe(false); // n1 not selected
  });

  test("empty query", () => {
    const r = runQuery(graph, "   ");
    expect(r.empty).toBe(true);
    expect(r.nodeIds.size).toBe(0);
  });

  test("syntax error is reported, not thrown", () => {
    const r = runQuery(graph, "(kind:function");
    expect(r.error).toBeTruthy();
    expect(r.nodeIds.size).toBe(0);
  });

  test("package field uses packageOf resolver", () => {
    const r = runQuery(graph, "pkg:apicore", {
      packageOf: (n) => (n.filePath.startsWith("src/api") ? "apicore" : "other"),
    });
    expect([...r.nodeIds].sort()).toEqual([n1.id, n2.id].sort());
  });
});
