import { describe, expect, test } from "bun:test";
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
  enabledNodeKinds: new Set(["function", "class"]),
  enabledCategories: new Set(["ui"]),
  enabledEnvironments: new Set(["client"]),
  enabledRuntimes: new Set(["node"]),
  enabledFolders: new Set(["src", "lib"]),
  enabledLanguages: new Set(["TS"]),
  algorithm: "smart",
  direction: "TB",
  groupBy: "community",
  density: 1.5,
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
    expect([...restored.enabledNodeKinds].sort()).toEqual([...state.enabledNodeKinds].sort());
    expect(restored.algorithm).toBe(state.algorithm);
    expect(restored.density).toBe(state.density);
    expect(restored.communityCollapse).toBe(true);
    expect(restored.camera).toEqual(state.camera);
    expect(restored.pinnedNodes).toEqual(state.pinnedNodes);
    expect([...restored.focusedIds!].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("capture serializes Sets as sorted arrays", () => {
    const ws = captureWorkspace(sample());
    expect(ws.filters.enabledNodeKinds).toEqual(["class", "function"]);
    expect(ws.expandedFiles).toEqual(["a.ts", "b.ts"]);
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
});
