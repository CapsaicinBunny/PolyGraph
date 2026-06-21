// Capstone Phase B test: a synthetic polyglot (TS + Rust + Go) graph must surface
// EVERY relevant filter dimension at once — provider facets included — with correct
// counts and eligibility, AND the generic scene gate must hide exactly the right
// nodes when a facet value is toggled off (parity with the old named-set gate).

import { expect, test } from "bun:test";
import { buildDimensionIndex } from "./dimension-index";
import {
  type DimensionDescriptor,
  type DimensionCatalog,
  mergeDescriptors,
  STRUCTURAL_DESCRIPTORS,
} from "./dimensions";
import type { FacetKey } from "./dimensions";
import { deriveFilterDimensions } from "./filter-derive";
import type { FacetSelection } from "./facet-selection";
import { writeFacet } from "./facets-write";
import { buildSceneStructure, type SceneFilters } from "./scene";
import type { GraphModel, GraphNode } from "./types";

// ── A synthetic multi-language catalog ────────────────────────────────────────
const TS_ROLE: DimensionDescriptor = {
  key: "role",
  label: "Role",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "react-component", label: "React component", color: "#22d3ee" },
    { value: "vue-component", label: "Vue component", color: "#42b883" },
  ],
  providerIds: ["typescript"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const TS_ENV: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client", color: "#fb923c" },
    { value: "server", label: "Server", color: "#2dd4bf" },
  ],
  providerIds: ["typescript"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const RUST_VIS: DimensionDescriptor = {
  key: "rust.visibility",
  label: "Visibility",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "pub", label: "pub", color: "#dea584" },
    { value: "crate", label: "crate", color: "#7f8c8d" },
  ],
  providerIds: ["rust"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};
const GO_EXPORTED: DimensionDescriptor = {
  key: "go.exported",
  label: "Exported",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "exported", label: "Exported", color: "#00add8" },
    { value: "unexported", label: "Unexported", color: "#888888" },
  ],
  providerIds: ["go"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

function polyCatalog(): DimensionCatalog {
  return mergeDescriptors([STRUCTURAL_DESCRIPTORS, [TS_ROLE, TS_ENV, RUST_VIS, GO_EXPORTED]])
    .catalog;
}

function sym(id: string, filePath: string, kind: GraphNode["kind"] = "function"): GraphNode {
  return { id, kind, label: id, filePath, line: 1, parentFile: filePath };
}

// TS file (react/client), Rust file (pub/crate symbols), Go file (exported/unexported).
function polyGraph(): GraphModel {
  const tsFile = { ...sym("app/ui.tsx", "app/ui.tsx", "file") };
  writeFacet(tsFile, "role", ["react-component"]);
  writeFacet(tsFile, "env", ["client"]);

  const rustPub = sym("core/lib.rs#open", "core/lib.rs");
  writeFacet(rustPub, "rust.visibility", ["pub"]);
  const rustCrate = sym("core/lib.rs#hidden", "core/lib.rs");
  writeFacet(rustCrate, "rust.visibility", ["crate"]);

  const goExp = sym("svc/main.go#Run", "svc/main.go");
  writeFacet(goExp, "go.exported", ["exported"]);
  const goUnexp = sym("svc/main.go#run", "svc/main.go");
  writeFacet(goUnexp, "go.exported", ["unexported"]);

  return {
    nodes: [
      tsFile,
      sym("core/lib.rs", "core/lib.rs", "file"),
      rustPub,
      rustCrate,
      sym("svc/main.go", "svc/main.go", "file"),
      goExp,
      goUnexp,
    ],
    edges: [],
  };
}

test("a TS+Rust+Go graph surfaces ALL its facet sections at once (role/env/rust/go)", () => {
  const graph = polyGraph();
  const catalog = polyCatalog();
  const index = buildDimensionIndex(graph, catalog);

  const dims = deriveFilterDimensions(graph, catalog, index);
  // role + env + rust.visibility + go.exported — every provider's dimension, together.
  expect(dims.map((d) => d.key).sort()).toEqual(["env", "go.exported", "role", "rust.visibility"]);
  expect(dims.map((d) => d.label).sort()).toEqual([
    "Environment",
    "Exported",
    "Role",
    "Visibility",
  ]);
});

test("each provider facet's per-value counts are correct", () => {
  const graph = polyGraph();
  const catalog = polyCatalog();
  const index = buildDimensionIndex(graph, catalog);
  const dims = deriveFilterDimensions(graph, catalog, index);
  const byKey = new Map(dims.map((d) => [d.key, d]));

  const count = (key: FacetKey, value: string) =>
    byKey.get(key)?.values.find((v) => v.value === value)?.count ?? -1;

  expect(count("rust.visibility", "pub")).toBe(1);
  expect(count("rust.visibility", "crate")).toBe(1);
  expect(count("go.exported", "exported")).toBe(1);
  expect(count("go.exported", "unexported")).toBe(1);
  expect(count("role", "react-component")).toBe(1);
  // vue-component is declared but present on no node → not surfaced.
  expect(count("role", "vue-component")).toBe(-1);
});

function filters(enabledFacets: Map<FacetKey, FacetSelection>): SceneFilters {
  return {
    showExternal: false,
    enabledFacets,
    enabledEdgeKinds: new Set(),
    enabledFolders: new Set(["app", "core", "svc", "/"]),
    enabledLanguages: new Set(["TX", "RS", "GO"]),
  };
}

test("excluding a Rust visibility value hides exactly those Rust symbols — and nothing else", () => {
  const graph = polyGraph();
  const catalog = polyCatalog();
  // expand all files so their symbols render
  const expanded = new Set(["app/ui.tsx", "core/lib.rs", "svc/main.go"]);

  const s = buildSceneStructure(
    graph,
    expanded,
    filters(new Map([["rust.visibility", { mode: "exclude", values: new Set(["crate"]) }]])),
    "force",
    "LR",
    new Set(),
    "directory",
    1,
    false,
    null,
    null,
    false,
    catalog,
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).not.toContain("core/lib.rs#hidden"); // crate symbol hidden
  expect(ids).toContain("core/lib.rs#open"); // pub symbol kept
  // Other languages' nodes are completely unaffected.
  expect(ids).toContain("svc/main.go#Run");
  expect(ids).toContain("svc/main.go#run");
  expect(ids).toContain("app/ui.tsx");
});

test("excluding a Go exported value hides only the Go symbols with that value", () => {
  const graph = polyGraph();
  const catalog = polyCatalog();
  const expanded = new Set(["app/ui.tsx", "core/lib.rs", "svc/main.go"]);

  const s = buildSceneStructure(
    graph,
    expanded,
    filters(new Map([["go.exported", { mode: "exclude", values: new Set(["unexported"]) }]])),
    "force",
    "LR",
    new Set(),
    "directory",
    1,
    false,
    null,
    null,
    false,
    catalog,
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).not.toContain("svc/main.go#run"); // unexported hidden
  expect(ids).toContain("svc/main.go#Run"); // exported kept
  expect(ids).toContain("core/lib.rs#open"); // Rust untouched
  expect(ids).toContain("core/lib.rs#hidden");
});

test("eligibility flags a >98% single-bucket dimension as ineligible (hidden from default)", () => {
  // A dimension where one value dominates >98% of all nodes.
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 200; i++) {
    const n = sym(`a/f${i}.go#x`, `a/f${i}.go`);
    writeFacet(n, "go.exported", ["exported"]);
    nodes.push(n);
  }
  const rare = sym("a/g.go#y", "a/g.go");
  writeFacet(rare, "go.exported", ["unexported"]);
  nodes.push(rare);

  const graph: GraphModel = { nodes, edges: [] };
  const catalog = polyCatalog();
  const index = buildDimensionIndex(graph, catalog);
  const dims = deriveFilterDimensions(graph, catalog, index);
  const go = dims.find((d) => d.key === "go.exported")!;

  expect(go.stats.distinctValues).toBe(2);
  expect(go.stats.largestBucketFraction).toBeGreaterThan(0.98);
  expect(go.stats.eligible).toBe(false);
});
