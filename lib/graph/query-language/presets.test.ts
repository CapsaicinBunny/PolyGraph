// Phase D — presets + back-compat.
//
// Every BUILTIN_SEARCH and every legacy saved-query string (role:react-component,
// env:client, runtime:node, …) must still PARSE and EVALUATE under the new
// dynamic-facet evaluation path — and produce the SAME result whether or not a
// DimensionIndex is supplied (the registry path and the legacy-field path agree).

import { describe, expect, test } from "bun:test";
import { buildDimensionIndex } from "../dimension-index";
import { type DimensionCatalog, STRUCTURAL_DESCRIPTORS } from "../dimensions";
import { writeFacet } from "../facets-write";
import { type GraphModel, type GraphNode, makeEdge } from "../types";
import { runQuery } from "./evaluate";
import { BUILTIN_SEARCHES } from "./presets";
import { TS_FACET_DESCRIPTORS } from "../../analyzer/facet-schema";

const sym = (filePath: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: `${filePath}#${name}`,
  kind: "function",
  label: name,
  filePath,
  line: 1,
  parentFile: filePath,
  ...extra,
});

// A graph exercising every preset + legacy-facet field. writeFacet keeps the
// legacy typed fields and node.facets in lock-step, so the indexed and legacy
// evaluation paths see identical data.
function buildGraph(): GraphModel {
  const page = sym("app/page.tsx", "Page", { kind: "component" });
  writeFacet(page, "role", ["react-component"]);
  writeFacet(page, "env", ["client"]);

  const listUsers = sym("src/api/users.ts", "listUsers");
  writeFacet(listUsers, "env", ["server"]);
  writeFacet(listUsers, "runtime", ["node"]);

  const widget = sym("src/ui/Widget.ts", "Widget", { kind: "class" });
  const helper = sym("src/ui/helper.ts", "helper", { kind: "function" });

  const db: GraphNode = {
    id: "external:database",
    kind: "external",
    label: "database",
    filePath: "",
    line: 0,
    parentFile: "external:database",
    externalKind: "npm",
    dependencyType: "dependency",
  };

  // a <-> b cycle for cycle:true.
  const a = sym("lib/a.ts", "A", { kind: "function" });
  const b = sym("lib/b.ts", "B", { kind: "function" });

  return {
    nodes: [page, listUsers, widget, helper, db, a, b],
    edges: [
      makeEdge(page.id, listUsers.id, "call"),
      makeEdge(widget.id, listUsers.id, "call"),
      makeEdge(helper.id, listUsers.id, "call"),
      makeEdge(listUsers.id, db.id, "import"),
      makeEdge(a.id, b.id, "call"),
      makeEdge(b.id, a.id, "call"),
    ],
  };
}

const graph = buildGraph();
const catalog: DimensionCatalog = {
  descriptors: [...STRUCTURAL_DESCRIPTORS, ...TS_FACET_DESCRIPTORS],
};
const index = buildDimensionIndex(graph, catalog);

const sortedIds = (q: string, withIndex: boolean) =>
  [...runQuery(graph, q, withIndex ? { dimensions: index } : {}).nodeIds].sort();

describe("BUILTIN_SEARCHES — parse + evaluate", () => {
  for (const search of BUILTIN_SEARCHES) {
    test(`"${search.name}" parses without error`, () => {
      const r = runQuery(graph, search.query, { dimensions: index });
      expect(r.error).toBeUndefined();
    });

    test(`"${search.name}" evaluates identically with and without an index`, () => {
      expect(sortedIds(search.query, true)).toEqual(sortedIds(search.query, false));
    });
  }

  test("the presets actually select the expected nodes", () => {
    // React rendering tree → the component (via role OR kind:component).
    expect(sortedIds("role:react-component | kind:component", true)).toEqual(["app/page.tsx#Page"]);
    // Database access → everything that (transitively) imports the db external.
    const dbAccess = sortedIds('depends-on:"database" | depends-on:"db"', true);
    expect(dbAccess).toContain("src/api/users.ts#listUsers");
    expect(dbAccess).toContain("app/page.tsx#Page");
    // Circular dependencies.
    expect(sortedIds("cycle:true", true)).toEqual(["lib/a.ts#A", "lib/b.ts#B"]);
    // High-impact: listUsers has 3 incoming, not >5 → empty; >0 selects it.
    expect(sortedIds("incoming:>5", true)).toEqual([]);
  });
});

describe("legacy saved-query strings — parse + evaluate (back-compat)", () => {
  // The kind of strings a user may have persisted to localStorage before Phase D.
  const SAVED = [
    "role:react-component",
    "env:client",
    "env:server",
    "environment:server", // legacy alias
    "runtime:node",
    "category:feature",
    "kind:component env:client",
    "role:react-component | env:server",
    "-env:client",
  ];

  for (const q of SAVED) {
    test(`"${q}" parses + evaluates the same with and without an index`, () => {
      const r = runQuery(graph, q, { dimensions: index });
      expect(r.error).toBeUndefined();
      expect(sortedIds(q, true)).toEqual(sortedIds(q, false));
    });
  }

  test("specific legacy results", () => {
    expect(sortedIds("role:react-component", true)).toEqual(["app/page.tsx#Page"]);
    expect(sortedIds("env:client", true)).toEqual(["app/page.tsx#Page"]);
    expect(sortedIds("env:server", true)).toEqual(["src/api/users.ts#listUsers"]);
    expect(sortedIds("environment:server", true)).toEqual(["src/api/users.ts#listUsers"]);
    expect(sortedIds("runtime:node", true)).toEqual(["src/api/users.ts#listUsers"]);
  });
});
