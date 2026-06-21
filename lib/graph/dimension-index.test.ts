import { expect, test } from "bun:test";
import { buildDimensionIndex } from "./dimension-index";
import {
  type DimensionDescriptor,
  type DimensionCatalog,
  STRUCTURAL_DESCRIPTORS,
} from "./dimensions";
import { writeFacet } from "./facets-write";
import type { GraphModel, GraphNode } from "./types";

function fileNode(filePath: string): GraphNode {
  return { id: filePath, kind: "file", label: filePath, filePath, line: 0, parentFile: filePath };
}

// A minimal category descriptor matching the TS analyzer's shape: closed, single,
// defaultValue "feature".
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

function catalog(extra: DimensionDescriptor[] = []): DimensionCatalog {
  return { descriptors: [...STRUCTURAL_DESCRIPTORS, ...extra] };
}

test("nodesWithValueId returns a Uint32Array of node ordinals", () => {
  const graph: GraphModel = { nodes: [fileNode("a.ts"), fileNode("src/b.ts")], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  const fileId = idx
    .present("kind")
    .map((p) => p.value)
    .indexOf("file");
  // resolve the interned id for "file" via present + valueString round-trip
  const ids = idx.valuesOfOrdinal(0, "kind");
  expect(ids.length).toBe(1);
  const postings = idx.nodesWithValueId("kind", ids[0]);
  expect(postings).toBeInstanceOf(Uint32Array);
  // both nodes are files → both ordinals present
  expect([...postings].sort((a, b) => a - b)).toEqual([0, 1]);
  expect(fileId).toBeGreaterThanOrEqual(0);
});

test("kind adapter: valuesOfNode reflects node.kind", () => {
  const node: GraphNode = {
    id: "a.ts#C",
    kind: "class",
    label: "C",
    filePath: "a.ts",
    line: 1,
    parentFile: "a.ts",
  };
  const graph: GraphModel = { nodes: [node], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  expect(idx.valuesOfNode(node, "kind")).toEqual(["class"]);
});

test("language adapter: derives the language key from filePath", () => {
  const graph: GraphModel = { nodes: [fileNode("a.ts"), fileNode("b.rs")], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  expect(idx.valuesOfNode(fileNode("a.ts"), "language")).toEqual(["TS"]);
  expect(idx.valuesOfNode(fileNode("b.rs"), "language")).toEqual(["RS"]);
});

test("folder adapter: derives the top folder from filePath", () => {
  const graph: GraphModel = { nodes: [fileNode("src/a.ts"), fileNode("root.ts")], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  expect(idx.valuesOfNode(fileNode("src/a.ts"), "folder")).toEqual(["src"]);
  expect(idx.valuesOfNode(fileNode("root.ts"), "folder")).toEqual(["/"]);
});

test("facet default is included in present() via complement even when unmaterialized", () => {
  // One node is UI (materialized facet); one is a plain feature (no facet stored).
  const ui = fileNode("ui.ts");
  writeFacet(ui, "category", ["ui"]);
  const plain = fileNode("plain.ts");
  writeFacet(plain, "category", ["feature"]); // default → NOT stored as a facet
  expect(plain.facets?.category).toBeUndefined();

  const graph: GraphModel = { nodes: [ui, plain], edges: [] };
  const idx = buildDimensionIndex(graph, catalog([CATEGORY]));

  const present = idx.present("category");
  const values = present.map((p) => p.value).sort();
  expect(values).toEqual(["feature", "ui"]);
  // both declared (they are in the closed domain)
  expect(present.every((p) => p.declared)).toBe(true);

  // The default value's posting is the complement: the "plain" node (ordinal 1).
  const featureId = idx.valuesOfOrdinal(1, "category")[0];
  expect(idx.valueString("category", featureId)).toBe("feature");
  expect([...idx.nodesWithValueId("category", featureId)]).toEqual([1]);

  // The materialized "ui" node (ordinal 0) resolves to "ui".
  const uiId = idx.valuesOfOrdinal(0, "category")[0];
  expect(idx.valueString("category", uiId)).toBe("ui");
});

// A multi-valued, closed runtime descriptor matching the TS analyzer's shape.
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

test("multi-valued facet column: valuesOfOrdinal + postings cover every value", () => {
  const both = fileNode("both.ts");
  writeFacet(both, "runtime", ["node", "bun"]);
  const justNode = fileNode("server.ts");
  writeFacet(justNode, "runtime", ["node"]);

  const graph: GraphModel = { nodes: [both, justNode], edges: [] };
  const idx = buildDimensionIndex(graph, catalog([RUNTIME]));

  // ordinal 0 carries both runtimes…
  const ids0 = idx.valuesOfOrdinal(0, "runtime");
  expect(ids0.length).toBe(2);
  expect([...ids0].map((id) => idx.valueString("runtime", id)).sort()).toEqual(["bun", "node"]);

  // postings: node → {0,1}, bun → {0}
  const nodeId = ids0.find((id) => idx.valueString("runtime", id) === "node")!;
  const bunId = ids0.find((id) => idx.valueString("runtime", id) === "bun")!;
  expect([...idx.nodesWithValueId("runtime", nodeId)].sort((a, b) => a - b)).toEqual([0, 1]);
  expect([...idx.nodesWithValueId("runtime", bunId)]).toEqual([0]);
});

test("accessor consistency: valuesOfOrdinal agrees with nodesWithValueId for every ordinal", () => {
  // Mix structural (kind/language/folder), a materialized facet, and an
  // unmaterialized default (the 'plain' node's category) so the complement path
  // is exercised on both accessors.
  const ui = fileNode("ui.ts");
  writeFacet(ui, "category", ["ui"]);
  const plain = fileNode("src/plain.ts"); // category default → no facet stored
  const both = fileNode("rt.ts");
  writeFacet(both, "runtime", ["node", "bun"]);

  const graph: GraphModel = { nodes: [ui, plain, both], edges: [] };
  const idx = buildDimensionIndex(graph, catalog([CATEGORY, RUNTIME]));

  for (const key of ["kind", "language", "folder", "category", "runtime"]) {
    // Interned ids are dense 0..n-1, one per present() value.
    const idCount = idx.present(key).length;
    expect(idCount).toBeGreaterThan(0);
    for (let ord = 0; ord < graph.nodes.length; ord++) {
      const idsFromNode = [...idx.valuesOfOrdinal(ord, key)].sort((a, b) => a - b);
      // The set of value ids whose columnar postings contain this ordinal.
      const idsFromPostings: number[] = [];
      for (let id = 0; id < idCount; id++) {
        if ([...idx.nodesWithValueId(key, id)].includes(ord)) idsFromPostings.push(id);
      }
      expect(idsFromNode).toEqual(idsFromPostings);
    }
  }
});

test("undeclared value on a closed dimension → declared:false + a warning, domain stays closed", () => {
  // Stuff an out-of-domain category value directly onto the model.
  const odd = fileNode("odd.ts");
  odd.facets = { category: ["mystery"] };
  const graph: GraphModel = { nodes: [odd], edges: [] };
  const idx = buildDimensionIndex(graph, catalog([CATEGORY]));

  const present = idx.present("category");
  const mystery = present.find((p) => p.value === "mystery");
  expect(mystery).toBeDefined();
  expect(mystery?.declared).toBe(false);

  // A warning names the key + value.
  const warn = idx.warnings.find((w) => w.key === "category" && w.value === "mystery");
  expect(warn).toBeDefined();

  // The descriptor's domain is unchanged (still closed).
  expect(idx.descriptor("category")?.domain).toBe("closed");
});

test("descriptor(key) returns the merged descriptor, undefined for unknown keys", () => {
  const graph: GraphModel = { nodes: [fileNode("a.ts")], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  expect(idx.descriptor("kind")?.key).toBe("kind");
  expect(idx.descriptor("nope")).toBeUndefined();
});

test("valuesOfOrdinal round-trips through valueString", () => {
  const graph: GraphModel = { nodes: [fileNode("src/a.ts")], edges: [] };
  const idx = buildDimensionIndex(graph, catalog());
  const langIds = idx.valuesOfOrdinal(0, "language");
  expect(langIds.length).toBe(1);
  expect(idx.valueString("language", langIds[0])).toBe("TS");
  const folderIds = idx.valuesOfOrdinal(0, "folder");
  expect(idx.valueString("folder", folderIds[0])).toBe("src");
});
