import { describe, expect, test } from "bun:test";
import type { FacetSelection } from "../graph/facet-selection";
import type { ExplorerWorkspaceState } from "./schema";
import { captureWorkspace, parseWorkspace, restoreWorkspace, workspaceToJSON } from "./serialize";

const sample = (): ExplorerWorkspaceState => ({
  projectPath: "C:/proj",
  selectedId: "a.ts#fn",
  expanded: new Set(["a.ts", "b.ts"]),
  collapsedClusters: new Set(["src"]),
  focusedIds: new Set(["a.ts", "b.ts"]),
  showExternal: true,
  search: "fn",
  enabledEdgeKinds: new Set(["import", "call"]),
  enabledFacets: new Map<string, FacetSelection>([
    ["kind", { mode: "include", values: new Set(["function", "class"]) }],
    ["category", { mode: "exclude", values: new Set(["feature"]) }],
  ]),
  enabledFolders: new Set(["src", "lib"]),
  enabledLanguages: new Set(["TS"]),
  algorithm: "smart",
  direction: "TB",
  groupBy: "community",
  density: 1.5,
  lodOpenPx: 80,
  edgeRouting: "orthogonal",
  communityCollapse: true,
  camera: { x: 10, y: 20, scale: 1.2 },
  pinnedNodes: { "a.ts": { x: 5, y: 5 } },
});

describe("capture / restore round-trip", () => {
  test("restore(capture(state)) preserves all fields", () => {
    const state = sample();
    const restored = restoreWorkspace(captureWorkspace(state));
    expect(restored.projectPath).toBe(state.projectPath);
    expect(restored.selectedId).toBe(state.selectedId);
    expect([...restored.expanded].sort()).toEqual([...state.expanded].sort());
    // facet selections round-trip (Set ↔ array, sorted)
    expect([...(restored.enabledFacets.get("kind")?.values ?? [])].sort()).toEqual([
      "class",
      "function",
    ]);
    expect(restored.enabledFacets.get("category")?.mode).toBe("exclude");
    expect(restored.algorithm).toBe(state.algorithm);
    expect(restored.density).toBe(state.density);
    expect(restored.lodOpenPx).toBe(state.lodOpenPx);
    expect(restored.communityCollapse).toBe(true);
    expect(restored.camera).toEqual(state.camera);
    expect(restored.pinnedNodes).toEqual(state.pinnedNodes);
    expect([...restored.focusedIds!].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("capture serializes facet selections as a sorted JSON map", () => {
    const ws = captureWorkspace(sample());
    expect(ws.filters.enabledFacets).toEqual({
      kind: { mode: "include", values: ["class", "function"] },
      category: { mode: "exclude", values: ["feature"] },
    });
    expect(ws.expandedFiles).toEqual(["a.ts", "b.ts"]);
    // legacy named arrays are NOT written by the current capture
    expect(ws.filters.enabledNodeKinds).toBeUndefined();
  });

  test("null focus and absent camera are handled", () => {
    const state = { ...sample(), focusedIds: null, camera: undefined, pinnedNodes: undefined };
    const ws = captureWorkspace(state);
    expect(ws.focusedIds).toBeNull();
    expect(ws.camera).toBeUndefined();
    expect("camera" in ws).toBe(false);
    expect(restoreWorkspace(ws).focusedIds).toBeNull();
  });
});

describe("JSON round-trip + validation", () => {
  test("workspaceToJSON → parseWorkspace round-trips", () => {
    const ws = captureWorkspace(sample());
    const parsed = parseWorkspace(workspaceToJSON(ws));
    expect(parsed).toEqual(ws);
  });

  test("rejects non-JSON and wrong shapes", () => {
    expect(() => parseWorkspace("{not json")).toThrow(/JSON/);
    expect(() => parseWorkspace("123")).toThrow(/object/);
    expect(() => parseWorkspace('{"version":1}')).toThrow(/filters/);
  });

  test("rejects a newer workspace version", () => {
    expect(() => parseWorkspace('{"version":999,"filters":{},"layout":{}}')).toThrow(/newer/);
  });

  test("rejects malformed-but-present filters/layout contents", () => {
    // filters/layout present but with wrong field types — must not restore undefined.
    const ws = captureWorkspace(sample());
    const broken = { ...ws, filters: { ...ws.filters, enabledFacets: { kind: { mode: "x" } } } };
    expect(() => parseWorkspace(JSON.stringify(broken))).toThrow(/enabledFacets/);

    const broken2 = { ...ws, layout: { ...ws.layout, density: "fast" } };
    expect(() => parseWorkspace(JSON.stringify(broken2))).toThrow(/density/);

    const broken3 = { ...ws, focusedIds: 5 };
    expect(() => parseWorkspace(JSON.stringify(broken3))).toThrow(/focusedIds/);
  });

  test("accepts a well-formed captured workspace", () => {
    expect(() => parseWorkspace(workspaceToJSON(captureWorkspace(sample())))).not.toThrow();
  });
});

describe("back-compat: legacy workspaces (named enabled* arrays) still load", () => {
  // A version-1 workspace written before the dimension spine — the four named
  // arrays, no `enabledFacets`. It must load and map to the generic selections.
  const legacyWorkspace = {
    version: 1,
    projectPath: "C:/old",
    selectedNode: null,
    expandedFiles: ["a.ts"],
    collapsedClusters: ["src"],
    focusedIds: null,
    filters: {
      showExternal: false,
      search: "",
      enabledEdgeKinds: ["import"],
      enabledNodeKinds: ["function", "class"],
      enabledCategories: ["ui"],
      enabledEnvironments: ["client"],
      enabledRuntimes: ["node", "bun"],
      enabledFolders: ["src"],
      enabledLanguages: ["TS"],
    },
    layout: {
      algorithm: "smart",
      direction: "LR",
      groupBy: "directory",
      density: 1,
      edgeRouting: "curved",
      communityCollapse: false,
    },
  };

  test("parseWorkspace accepts a legacy workspace (no enabledFacets)", () => {
    expect(() => parseWorkspace(JSON.stringify(legacyWorkspace))).not.toThrow();
  });

  test("legacy named arrays restore as include-mode facet selections (same filtering)", () => {
    const ws = parseWorkspace(JSON.stringify(legacyWorkspace));
    const state = restoreWorkspace(ws);
    expect(state.enabledFacets.get("kind")).toEqual({
      mode: "include",
      values: new Set(["function", "class"]),
    });
    expect(state.enabledFacets.get("category")).toEqual({
      mode: "include",
      values: new Set(["ui"]),
    });
    expect(state.enabledFacets.get("env")).toEqual({
      mode: "include",
      values: new Set(["client"]),
    });
    expect(state.enabledFacets.get("runtime")).toEqual({
      mode: "include",
      values: new Set(["node", "bun"]),
    });
    // structural folder/language still restore as before
    expect([...state.enabledFolders]).toEqual(["src"]);
    expect([...state.enabledLanguages]).toEqual(["TS"]);
  });

  test("a legacy workspace with no lodOpenPx restores the 120 default", () => {
    const state = restoreWorkspace(parseWorkspace(JSON.stringify(legacyWorkspace)));
    expect(state.lodOpenPx).toBe(120);
  });

  test("a legacy workspace with a malformed named array is rejected", () => {
    const broken = {
      ...legacyWorkspace,
      filters: { ...legacyWorkspace.filters, enabledNodeKinds: "oops" },
    };
    expect(() => parseWorkspace(JSON.stringify(broken))).toThrow(/enabledNodeKinds/);
  });
});
