// Phase D — dynamic facet fields in the query language.
//
// `runQuery` resolves `<key>:<value>` from the DimensionIndex for ANY registered
// dimension — the built-in facets (role/category/env/runtime) keyed by their
// catalog key, legacy aliases that map onto a catalog key (environment→env,
// lang→language), AND provider facets the legacy code path never knew about
// (e.g. rust.visibility). The built-in numeric/structural fields stay built-in.

import { describe, expect, test } from "bun:test";
import { buildDimensionIndex } from "../dimension-index";
import {
  type DimensionCatalog,
  type DimensionDescriptor,
  STRUCTURAL_DESCRIPTORS,
} from "../dimensions";
import { writeFacet } from "../facets-write";
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

// A Rust-flavored provider facet the legacy query path has no field for.
const RUST_VISIBILITY: DimensionDescriptor = {
  key: "rust.visibility",
  label: "Visibility",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "pub", label: "pub" },
    { value: "crate", label: "pub(crate)" },
    { value: "private", label: "private" },
  ],
  providerIds: ["rust"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

// role/category/env/runtime descriptors mirroring the TS provider (closed, single
// except runtime which is multi). category defaults to "feature".
const ROLE: DimensionDescriptor = {
  key: "role",
  label: "Role",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [{ value: "react-component", label: "React Component" }],
  providerIds: ["typescript"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const CATEGORY: DimensionDescriptor = {
  key: "category",
  label: "Category",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "ui", label: "UI" },
    { value: "feature", label: "Feature" },
  ],
  providerIds: ["typescript"],
  defaultValue: "feature",
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const ENV: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client" },
    { value: "server", label: "Server" },
  ],
  providerIds: ["typescript"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const RUNTIME: DimensionDescriptor = {
  key: "runtime",
  label: "Runtime",
  dimension: "facet",
  cardinality: "multi",
  domain: "closed",
  values: [
    { value: "node", label: "Node" },
    { value: "deno", label: "Deno" },
    { value: "bun", label: "Bun" },
  ],
  providerIds: ["typescript"],
  filterable: true,
  groupable: false,
  grouping: { mode: "disabled" },
  missing: { filter: "include", group: "unclassified" },
};

function facet(node: GraphNode, key: string, values: string[]): GraphNode {
  writeFacet(node, key, values);
  return node;
}

// n1/n2 server; n3 client react-component; n5 rust pub; n6 rust private.
const n1 = facet(sym("src/api/users.ts", "listUsers"), "env", ["server"]);
const n2 = facet(facet(sym("src/api/users.ts", "getUser"), "env", ["server"]), "category", ["ui"]);
const n3 = facet(
  facet(sym("app/page.tsx", "Page", { kind: "component" }), "role", ["react-component"]),
  "env",
  ["client"],
);
const n5 = facet(sym("crate/a.rs", "A", { kind: "struct" }), "rust.visibility", ["pub"]);
const n6 = facet(sym("crate/b.rs", "B", { kind: "struct" }), "rust.visibility", ["private"]);
const n7 = facet(sym("src/multi.ts", "M"), "runtime", ["node", "bun"]);

const graph: GraphModel = {
  nodes: [n1, n2, n3, n5, n6, n7],
  edges: [makeEdge(n3.id, n1.id, "call")],
};

const catalog: DimensionCatalog = {
  descriptors: [...STRUCTURAL_DESCRIPTORS, ROLE, CATEGORY, ENV, RUNTIME, RUST_VISIBILITY],
};

const index = buildDimensionIndex(graph, catalog);
const ids = (q: string) => [...runQuery(graph, q, { dimensions: index }).nodeIds].sort();

describe("runQuery — dynamic facet fields from the registry", () => {
  test("provider facet (rust.visibility) the legacy path never knew", () => {
    expect(ids("rust.visibility:pub")).toEqual([n5.id]);
    expect(ids("rust.visibility:private")).toEqual([n6.id]);
    expect(ids("rust.visibility:crate")).toEqual([]); // declared but unused
  });

  test("built-in facets resolve via the index by catalog key", () => {
    expect(ids("role:react-component")).toEqual([n3.id]);
    expect(ids("env:server")).toEqual([n1.id, n2.id].sort());
    expect(ids("env:client")).toEqual([n3.id]);
  });

  test("legacy alias environment maps to the env catalog key", () => {
    expect(ids("environment:server")).toEqual([n1.id, n2.id].sort());
    expect(ids("environment:client")).toEqual([n3.id]);
  });

  test("multi-valued runtime matches any of a node's values", () => {
    expect(ids("runtime:node")).toEqual([n7.id]);
    expect(ids("runtime:bun")).toEqual([n7.id]);
    expect(ids("runtime:deno")).toEqual([]);
  });

  test("category default (feature) is matched on nodes with no explicit value", () => {
    // n2 is the only explicit ui; everything else resolves to the default feature.
    expect(ids("category:ui")).toEqual([n2.id]);
    expect(ids("category:feature")).toEqual([n1.id, n3.id, n5.id, n6.id, n7.id].sort());
  });

  test("facet matching is case-insensitive on the value", () => {
    expect(ids("rust.visibility:PUB")).toEqual([n5.id]);
    expect(ids("ENV:Server")).toEqual([n1.id, n2.id].sort());
  });

  test("dynamic facets compose with built-in fields and boolean ops", () => {
    expect(ids("kind:struct rust.visibility:pub")).toEqual([n5.id]);
    expect(ids("rust.visibility:pub | rust.visibility:private")).toEqual([n5.id, n6.id].sort());
    expect(ids("kind:struct -rust.visibility:pub")).toEqual([n6.id]);
  });

  test("an unknown facet value yields no matches (not a lenient text fallback)", () => {
    expect(ids("env:nope")).toEqual([]);
    expect(ids("rust.visibility:protected")).toEqual([]);
  });

  test("a truly unregistered field still falls back to lenient text match", () => {
    // `nonsense` is no catalog dimension → text match on the value "users".
    expect(ids("nonsense:users")).toEqual([n1.id, n2.id].sort());
  });

  test("without an index, built-in legacy facet reads still work (back-compat)", () => {
    const legacyIds = (q: string) => [...runQuery(graph, q).nodeIds].sort();
    expect(legacyIds("env:server")).toEqual([n1.id, n2.id].sort());
    expect(legacyIds("role:react-component")).toEqual([n3.id]);
    expect(legacyIds("runtime:bun")).toEqual([n7.id]);
    // A provider facet has no legacy field → with no index it can't resolve and
    // falls back to a lenient text match (no node label/path contains "pub").
    expect(legacyIds("rust.visibility:pub")).toEqual([]);
  });
});
