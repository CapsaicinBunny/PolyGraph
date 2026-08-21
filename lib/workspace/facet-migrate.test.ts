import { expect, test } from "bun:test";
import type { FacetSelection } from "../graph/facet-selection";
import {
  facetSelectionsToState,
  facetStateToSelections,
  type FacetSelectionState,
  migrateLegacyEnabledFacets,
} from "./facet-migrate";

test("facetSelectionsToState: durable form is JSON-safe arrays (sorted)", () => {
  const runtime = new Map<string, FacetSelection>([
    ["env", { mode: "exclude", values: new Set(["server", "client"]) }],
  ]);
  const state = facetSelectionsToState(runtime);
  expect(state).toEqual({ env: { mode: "exclude", values: ["client", "server"] } });
});

test("facetSelectionsToState: drops no-op (all / empty-exclude) selections", () => {
  const runtime = new Map<string, FacetSelection>([
    ["env", { mode: "all", values: new Set(["client"]) }],
    ["category", { mode: "exclude", values: new Set() }],
    ["role", { mode: "include", values: new Set(["react-component"]) }],
  ]);
  const state = facetSelectionsToState(runtime);
  // only the constraining selection survives
  expect(Object.keys(state)).toEqual(["role"]);
});

test("facetStateToSelections: runtime form uses Sets (round-trip)", () => {
  const state: Record<string, FacetSelectionState> = {
    category: { mode: "include", values: ["ui"] },
  };
  const runtime = facetStateToSelections(state);
  expect(runtime.get("category")?.mode).toBe("include");
  expect([...(runtime.get("category")?.values ?? [])]).toEqual(["ui"]);
});

test("round-trip state → selections → state is stable", () => {
  const state: Record<string, FacetSelectionState> = {
    env: { mode: "exclude", values: ["client"] },
    kind: { mode: "include", values: ["class", "function"] },
  };
  expect(facetSelectionsToState(facetStateToSelections(state))).toEqual(state);
});

test("migrateLegacyEnabledFacets: old enabled* arrays become include-mode selections", () => {
  const state = migrateLegacyEnabledFacets({
    enabledNodeKinds: ["function", "class"],
    enabledCategories: ["ui"],
    enabledEnvironments: ["client"],
    enabledRuntimes: ["node"],
  });
  expect(state.kind).toEqual({ mode: "include", values: ["class", "function"] });
  expect(state.category).toEqual({ mode: "include", values: ["ui"] });
  expect(state.env).toEqual({ mode: "include", values: ["client"] });
  expect(state.runtime).toEqual({ mode: "include", values: ["node"] });
});

test("migrateLegacyEnabledFacets: missing legacy arrays are simply absent (all enabled)", () => {
  const state = migrateLegacyEnabledFacets({ enabledCategories: ["ui", "feature"] });
  expect(Object.keys(state)).toEqual(["category"]);
  expect(state.category).toEqual({ mode: "include", values: ["feature", "ui"] });
});

test("migrateLegacyEnabledFacets: an explicit new enabledFacets map wins over legacy arrays", () => {
  const state = migrateLegacyEnabledFacets({
    enabledFacets: { env: { mode: "exclude", values: ["server"] } },
    enabledCategories: ["ui"], // legacy ignored when the new field is present
  });
  expect(state).toEqual({ env: { mode: "exclude", values: ["server"] } });
});
