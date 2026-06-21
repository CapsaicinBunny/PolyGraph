import { describe, expect, test } from "bun:test";
import { clientCatalog } from "./client-catalog";
import { buildDimensionIndex } from "./dimension-index";
import type { DimensionDescriptor } from "./dimensions";
import { deriveGroupByOptions } from "./group-by-options";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const withFacet = (path: string, facets: Record<string, string[]>) => ({ ...file(path), facets });
const keys = (opts: { key: string }[]) => opts.map((o) => o.key);

describe("deriveGroupByOptions — the eligible group-by modes", () => {
  test("always offers Directory, Community and None (built-ins)", () => {
    const graph: GraphModel = { nodes: [file("a/x.ts")], edges: [] };
    const catalog = clientCatalog(undefined);
    const opts = deriveGroupByOptions(graph, catalog, buildDimensionIndex(graph, catalog), false);
    expect(keys(opts)).toContain("directory");
    expect(keys(opts)).toContain("community");
    expect(keys(opts)).toContain("none");
  });

  test("offers Package ONLY when manifests exist", () => {
    const graph: GraphModel = { nodes: [file("a/x.ts")], edges: [] };
    const catalog = clientCatalog(undefined);
    const index = buildDimensionIndex(graph, catalog);
    expect(keys(deriveGroupByOptions(graph, catalog, index, false))).not.toContain("package");
    expect(keys(deriveGroupByOptions(graph, catalog, index, true))).toContain("package");
  });

  test("offers an eligible groupable facet as 'facet:<key>'", () => {
    // env is single-cardinality (groupable: single) and, with a balanced split, eligible.
    const graph: GraphModel = {
      nodes: [
        withFacet("a.ts", { env: ["client"] }),
        withFacet("b.ts", { env: ["client"] }),
        withFacet("c.ts", { env: ["server"] }),
        withFacet("d.ts", { env: ["server"] }),
      ],
      edges: [],
    };
    const envDescriptor: DimensionDescriptor = {
      key: "env",
      label: "Environment",
      dimension: "facet",
      cardinality: "single",
      domain: "closed",
      values: [
        { value: "client", label: "Client" },
        { value: "server", label: "Server" },
      ],
      providerIds: ["core"],
      filterable: true,
      groupable: true,
      grouping: { mode: "single" },
      missing: { filter: "include", group: "unclassified" },
    };
    const catalog = { descriptors: [...clientCatalog(undefined).descriptors, envDescriptor] };
    const index = buildDimensionIndex(graph, catalog);
    const opts = deriveGroupByOptions(graph, catalog, index, false);
    const env = opts.find((o) => o.key === "facet:env");
    expect(env).toBeTruthy();
    expect(env!.label).toBe("Environment");
  });

  test("does NOT offer a multi-valued facet whose grouping is disabled", () => {
    const graph: GraphModel = {
      nodes: [
        withFacet("a.ts", { runtime: ["node", "bun"] }),
        withFacet("b.ts", { runtime: ["deno"] }),
        withFacet("c.ts", { runtime: ["node"] }),
      ],
      edges: [],
    };
    const runtimeDescriptor: DimensionDescriptor = {
      key: "runtime",
      label: "Runtime",
      dimension: "facet",
      cardinality: "multi",
      domain: "open",
      values: [],
      providerIds: ["core"],
      filterable: true,
      groupable: true,
      grouping: { mode: "disabled" }, // multi default → not groupable
      missing: { filter: "include", group: "unclassified" },
    };
    const catalog = { descriptors: [...clientCatalog(undefined).descriptors, runtimeDescriptor] };
    const index = buildDimensionIndex(graph, catalog);
    expect(keys(deriveGroupByOptions(graph, catalog, index, false))).not.toContain("facet:runtime");
  });

  test("does NOT offer an INELIGIBLE facet (one dominant value / too few distinct)", () => {
    // Every node is "feature" → one value, 100% bucket → ineligible.
    const graph: GraphModel = {
      nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
      edges: [],
    };
    const catDescriptor: DimensionDescriptor = {
      key: "category",
      label: "Category",
      dimension: "facet",
      cardinality: "single",
      domain: "closed",
      values: [{ value: "feature", label: "Feature" }],
      providerIds: ["core"],
      defaultValue: "feature",
      filterable: true,
      groupable: true,
      grouping: { mode: "single" },
      missing: { filter: "include", group: "unclassified" },
    };
    const catalog = { descriptors: [...clientCatalog(undefined).descriptors, catDescriptor] };
    const index = buildDimensionIndex(graph, catalog);
    expect(keys(deriveGroupByOptions(graph, catalog, index, false))).not.toContain(
      "facet:category",
    );
  });

  test("None is last (the explicit 'no grouping' option)", () => {
    const graph: GraphModel = { nodes: [file("a/x.ts")], edges: [] };
    const catalog = clientCatalog(undefined);
    const opts = deriveGroupByOptions(graph, catalog, buildDimensionIndex(graph, catalog), true);
    expect(opts[opts.length - 1].key).toBe("none");
  });
});
