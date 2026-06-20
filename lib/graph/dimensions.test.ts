import { expect, test } from "bun:test";
import {
  type DimensionDescriptor,
  mergeDescriptors,
  STRUCTURAL_DESCRIPTORS,
} from "./dimensions";
import { FILTERABLE_NODE_KINDS } from "./visual";

test("STRUCTURAL_DESCRIPTORS covers kind/language/folder, all structural + core", () => {
  const keys = STRUCTURAL_DESCRIPTORS.map((d) => d.key).sort();
  expect(keys).toEqual(["folder", "kind", "language"]);
  // No `package` in Phase A (deferred).
  expect(STRUCTURAL_DESCRIPTORS.some((d) => d.key === "package")).toBe(false);

  for (const d of STRUCTURAL_DESCRIPTORS) {
    expect(d.dimension).toBe("structural");
    expect(d.providerIds).toEqual(["core"]);
    expect(d.filterable).toBe(true);
    expect(d.groupable).toBe(true);
    expect(d.missing).toEqual({ filter: "exclude", group: "exclude" });
    expect(d.label.length).toBeGreaterThan(0);
  }
});

test("kind is a closed domain whose values come from FILTERABLE_NODE_KINDS", () => {
  const kind = STRUCTURAL_DESCRIPTORS.find((d) => d.key === "kind");
  expect(kind?.domain).toBe("closed");
  expect(kind?.cardinality).toBe("single");
  expect(kind?.values.map((v) => v.value)).toEqual([...FILTERABLE_NODE_KINDS]);
});

test("language and folder are open domains with no declared values", () => {
  for (const key of ["language", "folder"]) {
    const d = STRUCTURAL_DESCRIPTORS.find((x) => x.key === key);
    expect(d?.domain).toBe("open");
    expect(d?.values).toEqual([]);
  }
});

test("mergeDescriptors: core/built-in wins metadata; provider values are unioned", () => {
  const core: DimensionDescriptor = {
    key: "role",
    label: "Role",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [{ value: "a", label: "A core" }],
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  };
  const provider: DimensionDescriptor = {
    key: "role",
    label: "Provider Role Label",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [
      { value: "a", label: "A provider" },
      { value: "b", label: "B" },
    ],
    providerIds: ["typescript"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  };

  const { catalog, warnings } = mergeDescriptors([[core], [provider]]);
  expect(warnings).toEqual([]);
  expect(catalog.descriptors.length).toBe(1);
  const merged = catalog.descriptors[0];
  // First list wins metadata (label, etc.).
  expect(merged.label).toBe("Role");
  // Values unioned by .value; the first occurrence's metadata wins.
  expect(merged.values.map((v) => v.value)).toEqual(["a", "b"]);
  expect(merged.values.find((v) => v.value === "a")?.label).toBe("A core");
  // providerIds unioned.
  expect(merged.providerIds).toEqual(["core", "typescript"]);
});

test("mergeDescriptors: cardinality conflict upgrades to multi", () => {
  const single: DimensionDescriptor = {
    key: "env",
    label: "Env",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [],
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  };
  const multi: DimensionDescriptor = {
    ...single,
    cardinality: "multi",
    providerIds: ["other"],
  };
  const { catalog } = mergeDescriptors([[single], [multi]]);
  expect(catalog.descriptors[0].cardinality).toBe("multi");
});

test("mergeDescriptors: distinct keys are kept separate; providerIds dedupe", () => {
  const a: DimensionDescriptor = {
    key: "role",
    label: "Role",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [],
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  };
  const b: DimensionDescriptor = { ...a, key: "category", label: "Category" };
  // Same provider id appearing twice should dedupe in the union.
  const aAgain: DimensionDescriptor = { ...a, providerIds: ["core"] };
  const { catalog } = mergeDescriptors([[a], [b], [aAgain]]);
  expect(catalog.descriptors.map((d) => d.key).sort()).toEqual(["category", "role"]);
  expect(catalog.descriptors.find((d) => d.key === "role")?.providerIds).toEqual(["core"]);
});
