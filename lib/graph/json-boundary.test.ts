// Integration guard for the sidecar->client JSON boundary — the test class that was
// MISSING when 972 green tests still let the packaged app crash on every scan.
//
// The scan crash had two halves no unit test exercised together: (1) the analyzer
// emitted a *function* as a facet/role/externalKind value (a plain-object lookup table
// resolving Object.prototype members like `toString`/`constructor` for parsed
// identifiers — rampant in generated glue such as wasm-bindgen output); (2) that value
// crossed `JSON.stringify`/`JSON.parse` (the sidecar -> client boundary), where an
// array-element function/undefined becomes `null`, which then crashed value-keyed
// styling (`fallbackColor(null).length`). This harness runs REAL analyzer output
// through the wire and the full client memo pipeline, asserting both halves are safe.

import { describe, expect, test } from "bun:test";
import { analyzeSources } from "../analyzer";
import { clientCatalog } from "./client-catalog";
import { buildDimensionIndex } from "./dimension-index";
import { deriveFilterDimensions } from "./filter-derive";
import { availableFolders, availableLanguages } from "./filters";
import { deriveGroupByOptions } from "./group-by-options";
import { buildSceneStructure, type SceneFilters } from "./scene";
import type { GraphModel } from "./types";
import { FILTERABLE_EDGE_KINDS } from "./visual";

/** Serialize then parse — exactly what the scan response does crossing the sidecar. */
function overWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// A fixture deliberately loaded with identifiers that collide with Object.prototype
// keys, in every position a lookup table is indexed by parsed code: class decorators
// (roles.ts ANGULAR/ECS tables), a factory-call initializer (roles.ts ECS_FACTORIES),
// runtime-global member access (externals.ts + facets.ts RUNTIME_GLOBALS), and bare
// value references (facets.ts runtime globals). Plus a normal client component and a
// node-runtime file so the pipeline has real facets/dimensions to project.
const PROTOTYPE_TRAP: Record<string, string> = {
  "glue.ts": `
    @toString
    @constructor
    export class Widget {}
    export const made = valueOf();
    export const more = hasOwnProperty();
    export function g(o: { x: number }) {
      return [toString.call(o), constructor.name, valueOf.apply(o), propertyIsEnumerable];
    }
  `,
  "App.tsx": `"use client";\nexport function App() { return <div/>; }`,
  "fs.ts": `import { readFileSync } from "node:fs";\nexport function r() { return readFileSync(process.cwd()); }`,
};

describe("JSON-boundary integration (the gap that hid the scan crash)", () => {
  test("analyzer never emits a function as a role/externalKind/facet value", () => {
    const { graph } = analyzeSources(PROTOTYPE_TRAP);
    // Checked in-memory (pre-wire): JSON would mask a scalar function by dropping it,
    // so assert at the source where the bogus function value actually lives.
    for (const n of graph.nodes) {
      if (n.role !== undefined) expect(typeof n.role).toBe("string");
      if (n.externalKind !== undefined) expect(typeof n.externalKind).toBe("string");
      for (const values of Object.values(n.facets ?? {})) {
        for (const v of values) expect(typeof v).toBe("string");
      }
    }
  });

  test("real output survives the wire + full client memo pipeline without throwing", () => {
    const { graph: live } = analyzeSources(PROTOTYPE_TRAP);
    const graph: GraphModel = overWire(live);

    // No facet value arrived as null (what an array-element function/undefined becomes
    // over JSON) — the exact value that crashed fallbackColor on every scan.
    for (const n of graph.nodes) {
      for (const values of Object.values(n.facets ?? {})) {
        for (const v of values) expect(typeof v === "string" && v.length > 0).toBe(true);
      }
    }

    // The full client pipeline (the memos that ran on every scan) must not throw.
    const catalog = clientCatalog(undefined);
    const index = buildDimensionIndex(graph, catalog);
    const dims = deriveFilterDimensions(graph, catalog, index);
    deriveGroupByOptions(graph, catalog, index, false);
    expect(Array.isArray(dims)).toBe(true);

    const filters: SceneFilters = {
      showExternal: true, // exercise the external-node styling path (externalKind)
      enabledFacets: new Map(),
      enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
      enabledFolders: new Set(availableFolders(graph).map((f) => f.name)),
      enabledLanguages: new Set(availableLanguages(graph).map((l) => l.key)),
    };
    expect(() => buildSceneStructure(graph, new Set(), filters, "smart", "LR")).not.toThrow();
  });
});
