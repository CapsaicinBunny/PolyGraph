import { expect, test } from "bun:test";
import type { Environment, GraphModel, NodeCategory, Runtime } from "./types";
import { FILTERABLE_EDGE_KINDS, FILTERABLE_NODE_KINDS } from "./visual";
import { buildSceneStructure, type SceneFilters } from "./scene";

function fileNode(filePath: string) {
  return { id: filePath, kind: "file" as const, label: filePath, filePath, line: 0, parentFile: filePath };
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
  const s = buildSceneStructure(graph, new Set(), filters({ enabledFolders: new Set(["src", "/"]) }), "force", "LR");
  expect(s.nodes.map((n) => n.id)).not.toContain("lib/b.rs");
  expect(s.nodes.map((n) => n.id)).toContain("src/a.ts");
});

test("disabling a language hides its files (JSON off)", () => {
  const s = buildSceneStructure(graph, new Set(), filters({ enabledLanguages: new Set(["TS", "RS"]) }), "force", "LR");
  expect(s.nodes.map((n) => n.id)).not.toContain("pkg.json");
});
