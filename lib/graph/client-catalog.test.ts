import { expect, test } from "bun:test";
import { clientCatalog, FILTER_FACET_FALLBACK_KEYS } from "./client-catalog";
import type { DimensionCatalog } from "./dimensions";

test("clientCatalog falls back to structural + TS facets when result has no catalog", () => {
  const cat = clientCatalog(undefined);
  const keys = cat.descriptors.map((d) => d.key);
  // structural
  expect(keys).toContain("kind");
  expect(keys).toContain("language");
  expect(keys).toContain("folder");
  // TS facets — the "and more" that must surface even on the TS-only path
  expect(keys).toContain("role");
  expect(keys).toContain("category");
  expect(keys).toContain("env");
  expect(keys).toContain("runtime");
});

test("clientCatalog passes a provided catalog through unchanged", () => {
  const provided: DimensionCatalog = {
    descriptors: [
      {
        key: "rust.visibility",
        label: "Visibility",
        dimension: "facet",
        cardinality: "single",
        domain: "closed",
        values: [{ value: "pub", label: "pub" }],
        providerIds: ["rust"],
        filterable: true,
        groupable: true,
        grouping: { mode: "single" },
        missing: { filter: "include", group: "unclassified" },
      },
    ],
  };
  expect(clientCatalog(provided)).toBe(provided);
});

test("FILTER_FACET_FALLBACK_KEYS names the four TS facets", () => {
  expect([...FILTER_FACET_FALLBACK_KEYS].sort()).toEqual(["category", "env", "role", "runtime"]);
});
