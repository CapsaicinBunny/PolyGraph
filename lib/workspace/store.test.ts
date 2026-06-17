import { beforeEach, describe, expect, test } from "bun:test";
import type { Workspace } from "./schema";
import { deleteWorkspace, listWorkspaces, loadWorkspace, saveWorkspace } from "./store";

const ws = (path: string): Workspace => ({
  version: 1,
  projectPath: path,
  selectedNode: null,
  expandedFiles: [],
  collapsedClusters: [],
  focusedIds: null,
  filters: {
    showExternal: false,
    search: "",
    enabledEdgeKinds: [],
    enabledNodeKinds: [],
    enabledCategories: [],
    enabledEnvironments: [],
    enabledRuntimes: [],
    enabledFolders: [],
    enabledLanguages: [],
  },
  layout: {
    algorithm: "layered",
    direction: "LR",
    groupBy: "directory",
    density: 1,
    edgeRouting: "curved",
    communityCollapse: false,
  },
});

describe("workspace store (localStorage)", () => {
  beforeEach(() => localStorage.clear());

  test("save, list, load, delete", () => {
    saveWorkspace("first", ws("C:/a"), 1000);
    saveWorkspace("second", ws("C:/b"), 2000);

    const list = listWorkspaces();
    expect(list.map((w) => w.name)).toEqual(["second", "first"]); // most recent first
    expect(loadWorkspace("first")?.projectPath).toBe("C:/a");

    deleteWorkspace("first");
    expect(loadWorkspace("first")).toBeNull();
    expect(listWorkspaces()).toHaveLength(1);
  });

  test("saving the same name overwrites", () => {
    saveWorkspace("w", ws("C:/old"), 1);
    saveWorkspace("w", ws("C:/new"), 2);
    expect(listWorkspaces()).toHaveLength(1);
    expect(loadWorkspace("w")?.projectPath).toBe("C:/new");
  });
});
