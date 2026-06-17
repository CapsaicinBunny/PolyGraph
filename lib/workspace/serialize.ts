// Pure conversions between the live Explorer state (typed Sets) and the
// serializable Workspace (plain arrays). No DOM/storage here — that's store.ts.

import type { ViewEdgeKind } from "../aggregate";
import type { Environment, NodeCategory, NodeKind, Runtime } from "../graph/types";
import { type ExplorerWorkspaceState, type Workspace, WORKSPACE_VERSION } from "./schema";

/** Capture the current Explorer state as a serializable Workspace. */
export function captureWorkspace(state: ExplorerWorkspaceState): Workspace {
  return {
    version: WORKSPACE_VERSION,
    projectPath: state.projectPath,
    selectedNode: state.selectedId,
    expandedFiles: [...state.expanded].sort(),
    collapsedClusters: [...state.collapsedClusters].sort(),
    focusedIds: state.focusedIds ? [...state.focusedIds].sort() : null,
    filters: {
      showExternal: state.showExternal,
      search: state.search,
      enabledEdgeKinds: [...state.enabledEdgeKinds].sort(),
      enabledNodeKinds: [...state.enabledNodeKinds].sort(),
      enabledCategories: [...state.enabledCategories].sort(),
      enabledEnvironments: [...state.enabledEnvironments].sort(),
      enabledRuntimes: [...state.enabledRuntimes].sort(),
      enabledFolders: [...state.enabledFolders].sort(),
      enabledLanguages: [...state.enabledLanguages].sort(),
    },
    layout: {
      algorithm: state.algorithm,
      direction: state.direction,
      groupBy: state.groupBy,
      density: state.density,
      edgeRouting: state.edgeRouting,
      communityCollapse: state.communityCollapse,
    },
    ...(state.camera ? { camera: state.camera } : {}),
    ...(state.pinnedNodes ? { pinnedNodes: state.pinnedNodes } : {}),
  };
}

/** Rebuild live Explorer state from a Workspace (inverse of captureWorkspace). */
export function restoreWorkspace(ws: Workspace): ExplorerWorkspaceState {
  const f = ws.filters;
  return {
    projectPath: ws.projectPath,
    selectedId: ws.selectedNode,
    expanded: new Set(ws.expandedFiles),
    collapsedClusters: new Set(ws.collapsedClusters),
    focusedIds: ws.focusedIds ? new Set(ws.focusedIds) : null,
    showExternal: f.showExternal,
    search: f.search,
    enabledEdgeKinds: new Set(f.enabledEdgeKinds as ViewEdgeKind[]),
    enabledNodeKinds: new Set(f.enabledNodeKinds as NodeKind[]),
    enabledCategories: new Set(f.enabledCategories as NodeCategory[]),
    enabledEnvironments: new Set(f.enabledEnvironments as Environment[]),
    enabledRuntimes: new Set(f.enabledRuntimes as Runtime[]),
    enabledFolders: new Set(f.enabledFolders),
    enabledLanguages: new Set(f.enabledLanguages),
    algorithm: ws.layout.algorithm,
    direction: ws.layout.direction,
    groupBy: ws.layout.groupBy,
    density: ws.layout.density,
    edgeRouting: ws.layout.edgeRouting,
    communityCollapse: ws.layout.communityCollapse,
    ...(ws.camera ? { camera: ws.camera } : {}),
    ...(ws.pinnedNodes ? { pinnedNodes: ws.pinnedNodes } : {}),
  };
}

/** Serialize a Workspace to pretty JSON. */
export function workspaceToJSON(ws: Workspace): string {
  return `${JSON.stringify(ws, null, 2)}\n`;
}

/** Parse + validate a Workspace JSON document. Throws on the wrong shape. */
export function parseWorkspace(text: string): Workspace {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (typeof doc !== "object" || doc === null) throw new Error("Workspace must be an object");
  const ws = doc as Partial<Workspace>;
  if (typeof ws.version !== "number") throw new Error("Missing workspace version");
  if (ws.version > WORKSPACE_VERSION) {
    throw new Error(
      `Workspace version ${ws.version} is newer than supported (${WORKSPACE_VERSION})`,
    );
  }
  validateShape(ws);
  return ws as Workspace;
}

const STRING_ARRAY_FILTERS = [
  "enabledEdgeKinds",
  "enabledNodeKinds",
  "enabledCategories",
  "enabledEnvironments",
  "enabledRuntimes",
  "enabledFolders",
  "enabledLanguages",
] as const;

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate the contents (not just presence) of a workspace so a malformed but
 * present `filters`/`layout` can't restore `undefined` fields into Explorer state.
 */
function validateShape(ws: Partial<Workspace>): void {
  if (!ws.filters || typeof ws.filters !== "object")
    throw new Error("Workspace.filters is missing");
  if (!ws.layout || typeof ws.layout !== "object") throw new Error("Workspace.layout is missing");

  const f = ws.filters;
  if (typeof f.showExternal !== "boolean")
    throw new Error("filters.showExternal must be a boolean");
  if (typeof f.search !== "string") throw new Error("filters.search must be a string");
  for (const key of STRING_ARRAY_FILTERS) {
    if (!isStringArray(f[key])) throw new Error(`filters.${key} must be a string array`);
  }

  const l = ws.layout;
  for (const key of ["algorithm", "direction", "groupBy", "edgeRouting"] as const) {
    if (typeof l[key] !== "string") throw new Error(`layout.${key} must be a string`);
  }
  if (typeof l.density !== "number") throw new Error("layout.density must be a number");
  if (typeof l.communityCollapse !== "boolean") {
    throw new Error("layout.communityCollapse must be a boolean");
  }

  if (!isStringArray(ws.expandedFiles)) throw new Error("expandedFiles must be a string array");
  if (!isStringArray(ws.collapsedClusters)) {
    throw new Error("collapsedClusters must be a string array");
  }
  if (ws.focusedIds !== null && !isStringArray(ws.focusedIds)) {
    throw new Error("focusedIds must be a string array or null");
  }
}
