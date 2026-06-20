import { expect, test } from "bun:test";
import {
  type FacetSelection,
  facetAllows,
  serializeFacetSelections,
  valueEnabled,
} from "./facet-selection";

test("valueEnabled: absent selection (sparse) means every value is enabled", () => {
  const facets = new Map<string, FacetSelection>();
  expect(valueEnabled(facets, "role", "react-component")).toBe(true);
  expect(valueEnabled(facets, "anything", "whatever")).toBe(true);
});

test("valueEnabled: include mode enables only listed values", () => {
  const facets = new Map<string, FacetSelection>([
    ["category", { mode: "include", values: new Set(["ui"]) }],
  ]);
  expect(valueEnabled(facets, "category", "ui")).toBe(true);
  expect(valueEnabled(facets, "category", "feature")).toBe(false);
});

test("valueEnabled: exclude mode (the sparse 'all except one') disables only listed values", () => {
  const facets = new Map<string, FacetSelection>([
    ["category", { mode: "exclude", values: new Set(["feature"]) }],
  ]);
  expect(valueEnabled(facets, "category", "feature")).toBe(false);
  expect(valueEnabled(facets, "category", "ui")).toBe(true);
});

test("valueEnabled: mode 'all' enables everything regardless of values", () => {
  const facets = new Map<string, FacetSelection>([
    ["category", { mode: "all", values: new Set() }],
  ]);
  expect(valueEnabled(facets, "category", "ui")).toBe(true);
  expect(valueEnabled(facets, "category", "feature")).toBe(true);
});

test("facetAllows: single-valued node passes iff its one value is enabled", () => {
  const facets = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["client"]) }],
  ]);
  // include filter policy: missing → shown
  const missing = "include" as const;
  expect(facetAllows(facets, "env", ["server"], missing)).toBe(true);
  expect(facetAllows(facets, "env", ["client"], missing)).toBe(false);
});

test("facetAllows: multi-valued node passes iff ANY value is enabled", () => {
  const facets = new Map<string, FacetSelection>([
    ["runtime", { mode: "exclude", values: new Set(["node"]) }],
  ]);
  const missing = "include" as const;
  // node disabled, but bun is still enabled → kept
  expect(facetAllows(facets, "runtime", ["node", "bun"], missing)).toBe(true);
  // only node, which is disabled → hidden
  expect(facetAllows(facets, "runtime", ["node"], missing)).toBe(false);
});

test("facetAllows: absent value follows MissingPolicy.filter", () => {
  const facets = new Map<string, FacetSelection>();
  expect(facetAllows(facets, "env", [], "include")).toBe(true);
  expect(facetAllows(facets, "env", [], "exclude")).toBe(false);
  // "unclassified" is treated as shown by the filter gate (it is a grouping concept).
  expect(facetAllows(facets, "env", [], "unclassified")).toBe(true);
});

test("serializeFacetSelections: canonical + order-independent (sorted keys and values)", () => {
  const a = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["server", "client"]) }],
    ["category", { mode: "include", values: new Set(["ui"]) }],
  ]);
  const b = new Map<string, FacetSelection>([
    ["category", { mode: "include", values: new Set(["ui"]) }],
    ["env", { mode: "exclude", values: new Set(["client", "server"]) }],
  ]);
  expect(serializeFacetSelections(a)).toBe(serializeFacetSelections(b));
});

test("serializeFacetSelections: an 'all' / empty selection serializes the same as no entry", () => {
  const withAll = new Map<string, FacetSelection>([
    ["env", { mode: "all", values: new Set(["client"]) }],
  ]);
  const empty = new Map<string, FacetSelection>();
  expect(serializeFacetSelections(withAll)).toBe(serializeFacetSelections(empty));
});

test("serializeFacetSelections: differs when a value is excluded", () => {
  const none = new Map<string, FacetSelection>();
  const excludeOne = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["client"]) }],
  ]);
  expect(serializeFacetSelections(none)).not.toBe(serializeFacetSelections(excludeOne));
});
