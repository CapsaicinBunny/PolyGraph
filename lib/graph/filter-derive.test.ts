import { expect, test } from "bun:test";
import { buildDimensionIndex } from "./dimension-index";
import {
  type DimensionDescriptor,
  type DimensionCatalog,
  STRUCTURAL_DESCRIPTORS,
} from "./dimensions";
import { deriveFilterDimensions } from "./filter-derive";
import { writeFacet } from "./facets-write";
import type { GraphModel, GraphNode } from "./types";

function fileNode(filePath: string): GraphNode {
  return { id: filePath, kind: "file", label: filePath, filePath, line: 0, parentFile: filePath };
}
function sym(id: string, kind: GraphNode["kind"]): GraphNode {
  return { id, kind, label: id, filePath: "src/a.ts", line: 1, parentFile: "src/a.ts" };
}

const CATEGORY: DimensionDescriptor = {
  key: "category",
  label: "Category",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "ui", label: "UI", color: "#22c55e" },
    { value: "feature", label: "Feature", color: "#3b82f6" },
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
    { value: "client", label: "Client", color: "#fb923c" },
    { value: "server", label: "Server", color: "#2dd4bf" },
  ],
  providerIds: ["typescript"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

function catalog(extra: DimensionDescriptor[]): DimensionCatalog {
  return { descriptors: [...STRUCTURAL_DESCRIPTORS, ...extra] };
}

test("derives one dimension per filterable facet, excluding kind/folder/language by default", () => {
  const ui = sym("src/a.ts#C", "class");
  writeFacet(ui, "category", ["ui"]);
  const plain = sym("src/a.ts#fn", "function");
  writeFacet(plain, "category", ["feature"]);
  const graph: GraphModel = { nodes: [fileNode("src/a.ts"), ui, plain], edges: [] };
  const index = buildDimensionIndex(graph, catalog([CATEGORY]));

  const dims = deriveFilterDimensions(graph, catalog([CATEGORY]), index);
  expect(dims.map((d) => d.key)).toEqual(["category"]);
  expect(dims[0].label).toBe("Category");
});

test("each value carries its label/color and a node count", () => {
  const ui = sym("src/a.ts#C", "class");
  writeFacet(ui, "category", ["ui"]);
  const f1 = sym("src/a.ts#fn", "function");
  writeFacet(f1, "category", ["feature"]);
  const f2 = sym("src/a.ts#gn", "function");
  writeFacet(f2, "category", ["feature"]);
  const graph: GraphModel = { nodes: [fileNode("src/a.ts"), ui, f1, f2], edges: [] };
  const index = buildDimensionIndex(graph, catalog([CATEGORY]));

  const [cat] = deriveFilterDimensions(graph, catalog([CATEGORY]), index);
  const byValue = new Map(cat.values.map((v) => [v.value, v]));
  expect(byValue.get("ui")?.count).toBe(1);
  expect(byValue.get("ui")?.label).toBe("UI");
  expect(byValue.get("ui")?.color).toBe("#22c55e");
  // "feature" is the default (unmaterialized) — its count is the complement (the file +
  // both functions = 3 nodes have no explicit category → resolve to feature).
  expect(byValue.get("feature")?.count).toBe(3);
});

test("a value present on no node is dropped (present() only)", () => {
  // No node is "client"; only server appears.
  const s = fileNode("src/server.ts");
  writeFacet(s, "env", ["server"]);
  const graph: GraphModel = { nodes: [s], edges: [] };
  const index = buildDimensionIndex(graph, catalog([ENV]));

  const [env] = deriveFilterDimensions(graph, catalog([ENV]), index);
  expect(env.values.map((v) => v.value)).toEqual(["server"]);
});

test("eligibility: a >=2-value, well-spread dimension is eligible", () => {
  const ui = sym("src/a.ts#C", "class");
  writeFacet(ui, "category", ["ui"]);
  const f1 = sym("src/a.ts#fn", "function");
  writeFacet(f1, "category", ["feature"]);
  const graph: GraphModel = { nodes: [ui, f1], edges: [] };
  const index = buildDimensionIndex(graph, catalog([CATEGORY]));

  const [cat] = deriveFilterDimensions(graph, catalog([CATEGORY]), index);
  expect(cat.stats.distinctValues).toBe(2);
  expect(cat.stats.eligible).toBe(true);
});

test("eligibility: a single-value dimension is ineligible", () => {
  // Only server — one distinct value.
  const a = fileNode("a.ts");
  writeFacet(a, "env", ["server"]);
  const b = fileNode("b.ts");
  writeFacet(b, "env", ["server"]);
  const graph: GraphModel = { nodes: [a, b], edges: [] };
  const index = buildDimensionIndex(graph, catalog([ENV]));

  const [env] = deriveFilterDimensions(graph, catalog([ENV]), index);
  expect(env.stats.distinctValues).toBe(1);
  expect(env.stats.eligible).toBe(false);
});

test("eligibility: a >98% single-bucket dimension is ineligible (largest bucket too dominant)", () => {
  // 100 server nodes, 1 client → 100/101 ≈ 99% in one bucket.
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 100; i++) {
    const n = fileNode(`s${i}.ts`);
    writeFacet(n, "env", ["server"]);
    nodes.push(n);
  }
  const c = fileNode("c.ts");
  writeFacet(c, "env", ["client"]);
  nodes.push(c);
  const graph: GraphModel = { nodes, edges: [] };
  const index = buildDimensionIndex(graph, catalog([ENV]));

  const [env] = deriveFilterDimensions(graph, catalog([ENV]), index);
  expect(env.stats.distinctValues).toBe(2);
  expect(env.stats.largestBucketFraction).toBeGreaterThan(0.98);
  expect(env.stats.eligible).toBe(false);
});

test("undeclared closed value surfaces with declared:false and a deterministic color", () => {
  const odd = sym("src/a.ts#x", "function");
  odd.facets = { category: ["mystery"] };
  const graph: GraphModel = { nodes: [odd], edges: [] };
  const index = buildDimensionIndex(graph, catalog([CATEGORY]));

  const [cat] = deriveFilterDimensions(graph, catalog([CATEGORY]), index);
  const mystery = cat.values.find((v) => v.value === "mystery");
  expect(mystery).toBeDefined();
  expect(mystery?.declared).toBe(false);
  // Falls back to the raw value as a label and a non-empty color (deterministic palette).
  expect(mystery?.label).toBe("mystery");
  expect(typeof mystery?.color).toBe("string");
  expect(mystery?.color.length).toBeGreaterThan(0);
});

test("values are sorted by count descending (busiest first), ties by label", () => {
  const ui = sym("src/a.ts#C", "class");
  writeFacet(ui, "category", ["ui"]);
  const f1 = sym("src/a.ts#fn", "function");
  writeFacet(f1, "category", ["feature"]);
  const f2 = sym("src/a.ts#gn", "function");
  writeFacet(f2, "category", ["feature"]);
  const graph: GraphModel = { nodes: [ui, f1, f2], edges: [] };
  const index = buildDimensionIndex(graph, catalog([CATEGORY]));

  const [cat] = deriveFilterDimensions(graph, catalog([CATEGORY]), index);
  // feature (2) before ui (1)
  expect(cat.values.map((v) => v.value)).toEqual(["feature", "ui"]);
});
