import { expect, test } from "bun:test";
import { edgeWeight } from "../layout/weight";
import type { GraphModel } from "./types";
import { FILTERABLE_EDGE_KINDS } from "./visual";
import type { FacetKey } from "./dimensions";
import type { FacetSelection } from "./facet-selection";
import { writeFacet } from "./facets-write";
import { mergeDescriptors, STRUCTURAL_DESCRIPTORS, type DimensionCatalog } from "./dimensions";
import { TS_FACET_DESCRIPTORS } from "../analyzer/facet-schema";
import { buildSceneStructure, type SceneFilters } from "./scene";

function fileNode(filePath: string) {
  return {
    id: filePath,
    kind: "file" as const,
    label: filePath,
    filePath,
    line: 0,
    parentFile: filePath,
  };
}

const graph: GraphModel = {
  nodes: [fileNode("src/a.ts"), fileNode("lib/b.rs"), fileNode("pkg.json")],
  edges: [],
};

/** Build an enabledFacets map that excludes exactly the given values of one facet. */
function exclude(key: FacetKey, ...values: string[]): Map<FacetKey, FacetSelection> {
  return new Map([[key, { mode: "exclude", values: new Set(values) }]]);
}

function filters(overrides: Partial<SceneFilters> = {}): SceneFilters {
  return {
    showExternal: false,
    // Sparse: an empty map means every value of every facet is enabled.
    enabledFacets: new Map<FacetKey, FacetSelection>(),
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    enabledFolders: new Set(["src", "lib", "/"]),
    enabledLanguages: new Set(["TS", "RS", "{}"]),
    ...overrides,
  };
}

test("all files visible when every folder + language is enabled", () => {
  const s = buildSceneStructure(graph, new Set(), filters(), "force", "LR");
  expect(s.nodes.map((n) => n.id).sort()).toEqual(["lib/b.rs", "pkg.json", "src/a.ts"]);
});

test("disabling a folder hides its files", () => {
  const s = buildSceneStructure(
    graph,
    new Set(),
    filters({ enabledFolders: new Set(["src", "/"]) }),
    "force",
    "LR",
  );
  expect(s.nodes.map((n) => n.id)).not.toContain("lib/b.rs");
  expect(s.nodes.map((n) => n.id)).toContain("src/a.ts");
});

test("disabling a language hides its files (JSON off)", () => {
  const s = buildSceneStructure(
    graph,
    new Set(),
    filters({ enabledLanguages: new Set(["TS", "RS"]) }),
    "force",
    "LR",
  );
  expect(s.nodes.map((n) => n.id)).not.toContain("pkg.json");
});

// ── Generic facet gate: kind / category / env / runtime ───────────────────────
// These assert the registry-driven gate hides EXACTLY the nodes the old named-set
// gate did (behavior-preserving parity), expressed through the sparse enabledFacets.

function symbol(id: string, kind: GraphModel["nodes"][number]["kind"]) {
  return { id, kind, label: id, filePath: "src/a.ts", line: 1, parentFile: "src/a.ts" };
}

// A file plus two symbols inside it; expanded so the symbols render. Facets are
// dual-written via writeFacet exactly as the analyzer produces them (the index
// reads node.facets, not the legacy typed fields).
const fn = symbol("src/a.ts#fn", "function") as GraphModel["nodes"][number];
writeFacet(fn, "category", ["feature"]); // default → not materialized; resolves via complement
const cls = symbol("src/a.ts#C", "class") as GraphModel["nodes"][number];
writeFacet(cls, "category", ["ui"]);
const withSymbols: GraphModel = { nodes: [fileNode("src/a.ts"), fn, cls], edges: [] };
const expandAll = new Set(["src/a.ts"]);

test("disabling a node kind hides exactly that kind's symbols (not files)", () => {
  const s = buildSceneStructure(
    withSymbols,
    expandAll,
    filters({ enabledFacets: exclude("kind", "function") }),
    "force",
    "LR",
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).toContain("src/a.ts"); // file unaffected by the kind gate
  expect(ids).toContain("src/a.ts#C"); // class kept
  expect(ids).not.toContain("src/a.ts#fn"); // function hidden
});

test("disabling a category hides exactly that category's symbols", () => {
  const s = buildSceneStructure(
    withSymbols,
    expandAll,
    filters({ enabledFacets: exclude("category", "ui") }),
    "force",
    "LR",
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).toContain("src/a.ts#fn"); // feature kept
  expect(ids).not.toContain("src/a.ts#C"); // ui hidden
});

test("disabling an environment hides nodes with that environment (files included)", () => {
  const g: GraphModel = {
    nodes: [fileNode("src/client.ts"), fileNode("src/server.ts")],
    edges: [],
  };
  writeFacet(g.nodes[0], "env", ["client"]);
  writeFacet(g.nodes[1], "env", ["server"]);
  const s = buildSceneStructure(
    g,
    new Set(),
    filters({ enabledFacets: exclude("env", "client") }),
    "force",
    "LR",
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).toContain("src/server.ts");
  expect(ids).not.toContain("src/client.ts");
});

test("multi-valued runtime: a node survives if ANY of its runtimes stays enabled", () => {
  const g: GraphModel = { nodes: [fileNode("src/iso.ts"), fileNode("src/node.ts")], edges: [] };
  writeFacet(g.nodes[0], "runtime", ["node", "bun"]);
  writeFacet(g.nodes[1], "runtime", ["node"]);
  const s = buildSceneStructure(
    g,
    new Set(),
    filters({ enabledFacets: exclude("runtime", "node") }),
    "force",
    "LR",
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).toContain("src/iso.ts"); // still has bun enabled
  expect(ids).not.toContain("src/node.ts"); // only node, which is disabled
});

test("a node with no environment is kept when an environment is disabled (MissingPolicy include)", () => {
  const g: GraphModel = { nodes: [fileNode("src/plain.ts")], edges: [] };
  const s = buildSceneStructure(
    g,
    new Set(),
    filters({ enabledFacets: exclude("env", "client", "server") }),
    "force",
    "LR",
  );
  expect(s.nodes.map((n) => n.id)).toContain("src/plain.ts");
});

// Two disjoint 2-cycles → two communities of size 2.
const cyclic: GraphModel = {
  nodes: [fileNode("pkg/a.ts"), fileNode("pkg/b.ts"), fileNode("util/c.ts"), fileNode("util/d.ts")],
  edges: [
    {
      id: "pkg/a.ts->pkg/b.ts:import",
      source: "pkg/a.ts",
      target: "pkg/b.ts",
      kind: "import",
      occurrences: [],
      count: 0,
    },
    {
      id: "pkg/b.ts->pkg/a.ts:import",
      source: "pkg/b.ts",
      target: "pkg/a.ts",
      kind: "import",
      occurrences: [],
      count: 0,
    },
    {
      id: "util/c.ts->util/d.ts:import",
      source: "util/c.ts",
      target: "util/d.ts",
      kind: "import",
      occurrences: [],
      count: 0,
    },
    {
      id: "util/d.ts->util/c.ts:import",
      source: "util/d.ts",
      target: "util/c.ts",
      kind: "import",
      occurrences: [],
      count: 0,
    },
  ],
};
const communityFilters = filters({ enabledFolders: new Set(["pkg", "util"]) });

test("communityCollapse folds every multi-member community into one aggregate card", () => {
  // args: graph, expanded, filters, algorithm, direction, collapsedClusters, groupBy, density, communityCollapse
  const s = buildSceneStructure(
    cyclic,
    new Set(),
    communityFilters,
    "smart",
    "LR",
    new Set(),
    "community",
    1,
    true,
  );
  expect(s.nodes).toHaveLength(2);
  expect(s.nodes.every((n) => n.id.endsWith("#__agg__"))).toBe(true);
});

test("community grouping with the collapse toggle off keeps the individual nodes", () => {
  const s = buildSceneStructure(
    cyclic,
    new Set(),
    communityFilters,
    "smart",
    "LR",
    new Set(),
    "community",
    1,
    false,
  );
  expect(s.nodes).toHaveLength(4);
  expect(s.nodes.some((n) => n.id.endsWith("#__agg__"))).toBe(false);
});

test("focusedIds shows exactly the focused subgraph, overriding other filters", () => {
  const s = buildSceneStructure(
    graph,
    new Set(),
    filters(),
    "force",
    "LR",
    new Set(),
    "directory",
    1,
    false,
    new Set(["src/a.ts"]),
  );
  expect(s.nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
});

test("focusing symbol nodes also surfaces their parent file (not an empty canvas)", () => {
  // A function↔function cycle inside one file — the shape behind the 2-node circular
  // dependency that rendered empty before the fix.
  const withSymbols: GraphModel = {
    nodes: [
      fileNode("src/a.ts"),
      {
        id: "src/a.ts#foo",
        kind: "function",
        label: "foo",
        filePath: "src/a.ts",
        line: 1,
        parentFile: "src/a.ts",
      },
      {
        id: "src/a.ts#bar",
        kind: "function",
        label: "bar",
        filePath: "src/a.ts",
        line: 2,
        parentFile: "src/a.ts",
      },
    ],
    edges: [],
  };
  const s = buildSceneStructure(
    withSymbols,
    new Set(), // nothing expanded — the focus must force the parent file open itself
    filters(),
    "smart",
    "LR",
    new Set(),
    "directory",
    1,
    false,
    new Set(["src/a.ts#foo", "src/a.ts#bar"]),
  );
  const ids = s.nodes.map((n) => n.id);
  expect(ids).toContain("src/a.ts#foo");
  expect(ids).toContain("src/a.ts#bar");
  expect(ids).toContain("src/a.ts"); // parent file shown as the container
});

// One import edge with a real count, so the layout input must expose a weight.
const weighted: GraphModel = {
  nodes: [fileNode("src/a.ts"), fileNode("src/b.ts")],
  edges: [
    {
      id: "src/a.ts->src/b.ts:import",
      source: "src/a.ts",
      target: "src/b.ts",
      kind: "import",
      occurrences: [],
      count: 3,
    },
  ],
};

test("layoutInput edges carry kind, count, and a precomputed weight (Gap B)", () => {
  const s = buildSceneStructure(weighted, new Set(), filters(), "layered", "LR");
  const e = s.layoutInput.edges.find((x) => x.source === "src/a.ts" && x.target === "src/b.ts");
  expect(e).toBeDefined();
  expect(e?.kind).toBe("import");
  expect(e?.count).toBe(3);
  expect(e?.weight).toBe(edgeWeight("import", 3));
});

test("the layout signature includes catalog identity (distinct catalogs cannot collide)", () => {
  // Two analyses can gate the SAME graph by DIFFERENT catalogs (e.g. the kernel's
  // merged catalog on the canvas vs. the TS/JS fallback in an export). They generally
  // produce different visible sets, so their signatures must differ — otherwise one
  // serves the other's cached layout and filtered-out nodes reappear at (0,0).
  const catalogA: DimensionCatalog = mergeDescriptors([STRUCTURAL_DESCRIPTORS]).catalog;
  const catalogB: DimensionCatalog = mergeDescriptors([
    STRUCTURAL_DESCRIPTORS,
    TS_FACET_DESCRIPTORS,
  ]).catalog;
  const args = [
    graph,
    new Set<string>(),
    filters(),
    "force",
    "LR",
    new Set<string>(),
    "directory",
    1,
    false,
    null,
    null,
    false,
  ] as const;
  const sigA = buildSceneStructure(...args, catalogA).signature;
  const sigB = buildSceneStructure(...args, catalogB).signature;
  expect(sigA).not.toBe(sigB);
  // Same catalog, identical inputs → identical signature (cache hits are still possible).
  const sigA2 = buildSceneStructure(...args, catalogA).signature;
  expect(sigA2).toBe(sigA);
});

test("queryIds narrows the visible set and intersects with the filters", () => {
  // Query selects a.ts and b.rs, but the RS language is disabled → only a.ts survives.
  const s = buildSceneStructure(
    graph,
    new Set(),
    filters({ enabledLanguages: new Set(["TS", "{}"]) }),
    "force",
    "LR",
    new Set(),
    "directory",
    1,
    false,
    null,
    new Set(["src/a.ts", "lib/b.rs"]),
  );
  expect(s.nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
});
