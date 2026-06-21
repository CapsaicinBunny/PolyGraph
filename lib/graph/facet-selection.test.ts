import { expect, test } from "bun:test";
import {
  type FacetSelection,
  facetAllows,
  serializeFacetSelections,
  setFacetValues,
  toggleFacetValue,
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

test("toggleFacetValue: disabling one value of an all-enabled facet stores just that value (sparse)", () => {
  const next = toggleFacetValue(new Map(), "env", "client");
  const sel = next.get("env")!;
  expect(sel.mode).toBe("exclude");
  expect([...sel.values]).toEqual(["client"]);
  // the other value is still enabled
  expect(valueEnabled(next, "env", "server")).toBe(true);
  expect(valueEnabled(next, "env", "client")).toBe(false);
});

test("toggleFacetValue: re-enabling the last excluded value clears the entry (back to all)", () => {
  const facets = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["client"]) }],
  ]);
  const next = toggleFacetValue(facets, "env", "client");
  expect(next.has("env")).toBe(false); // normalized away — all enabled again
});

test("toggleFacetValue: does not mutate the input map", () => {
  const facets = new Map<string, FacetSelection>();
  toggleFacetValue(facets, "env", "client");
  expect(facets.size).toBe(0);
});

test("toggleFacetValue: within include mode, removing a value keeps include mode", () => {
  const facets = new Map<string, FacetSelection>([
    ["kind", { mode: "include", values: new Set(["class", "function"]) }],
  ]);
  const next = toggleFacetValue(facets, "kind", "function");
  expect(next.get("kind")?.mode).toBe("include");
  expect([...(next.get("kind")?.values ?? [])]).toEqual(["class"]);
});

test("setFacetValues off for the whole present domain disables every value (none)", () => {
  const next = setFacetValues(new Map(), "env", ["client", "server"], false);
  expect(valueEnabled(next, "env", "client")).toBe(false);
  expect(valueEnabled(next, "env", "server")).toBe(false);
});

test("setFacetValues on for an excluded set re-enables and clears the entry", () => {
  const facets = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["client", "server"]) }],
  ]);
  const next = setFacetValues(facets, "env", ["client", "server"], true);
  expect(next.has("env")).toBe(false);
});

test("setFacetValues toggles only a subset (a Node-types layer), leaving others enabled", () => {
  // Disable just the 'class','function' layer; 'interface' (not in the set) stays on.
  const next = setFacetValues(new Map(), "kind", ["class", "function"], false);
  expect(valueEnabled(next, "kind", "class")).toBe(false);
  expect(valueEnabled(next, "kind", "function")).toBe(false);
  expect(valueEnabled(next, "kind", "interface")).toBe(true);
});
