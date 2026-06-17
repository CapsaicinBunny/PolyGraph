import { expect, test } from "bun:test";
import type { Environment, GraphModel, NodeCategory, Runtime } from "./types";
import { FILTERABLE_EDGE_KINDS, FILTERABLE_NODE_KINDS } from "./visual";
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

function filters(overrides: Partial<SceneFilters> = {}): SceneFilters {
  return {
    showExternal: false,
    enabledNodeKinds: new Set(FILTERABLE_NODE_KINDS),
    enabledCategories: new Set<NodeCategory>(["ui", "feature"]),
    enabledEnvironments: new Set<Environment>(["client", "server"]),
    enabledRuntimes: new Set<Runtime>(["node", "deno", "bun"]),
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
