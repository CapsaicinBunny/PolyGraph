// Serializable description of an Explorer session — the filters, layout,
// expansion, selection, and (best-effort) camera/pins that make a view
// reproducible. This is what "Save workspace" / "Export workspace JSON" writes
// and "Load workspace" reads. Sets are stored as arrays so it's plain JSON.

import type { ViewEdgeKind } from "../aggregate";
import type { Environment, NodeCategory, NodeKind, Runtime } from "../graph/types";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "../layout";

export type EdgeRouting = "curved" | "orthogonal";

export interface WorkspaceFilters {
  showExternal: boolean;
  search: string;
  enabledEdgeKinds: string[];
  enabledNodeKinds: string[];
  enabledCategories: string[];
  enabledEnvironments: string[];
  enabledRuntimes: string[];
  enabledFolders: string[];
  enabledLanguages: string[];
}

export interface WorkspaceLayout {
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  groupBy: GroupBy;
  density: number;
  edgeRouting: EdgeRouting;
  communityCollapse: boolean;
}

export interface CameraState {
  x: number;
  y: number;
  scale: number;
}

export const WORKSPACE_VERSION = 1;

export interface Workspace {
  version: number;
  projectPath: string;
  selectedNode: string | null;
  expandedFiles: string[];
  collapsedClusters: string[];
  /** The active focus subgraph (impact mode), or null when not focusing. */
  focusedIds: string[] | null;
  filters: WorkspaceFilters;
  layout: WorkspaceLayout;
  /** Renderer-internal; present when capturable, restored best-effort. */
  camera?: CameraState;
  /** Manually pinned node positions, by node id. */
  pinnedNodes?: Record<string, { x: number; y: number }>;
}

/**
 * The live Explorer state captured/restored by serialize.ts. Mirrors the
 * useState values held in components/Explorer.tsx, with their precise Set types.
 */
export interface ExplorerWorkspaceState {
  projectPath: string;
  selectedId: string | null;
  expanded: Set<string>;
  collapsedClusters: Set<string>;
  focusedIds: Set<string> | null;
  showExternal: boolean;
  search: string;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  enabledNodeKinds: Set<NodeKind>;
  enabledCategories: Set<NodeCategory>;
  enabledEnvironments: Set<Environment>;
  enabledRuntimes: Set<Runtime>;
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  groupBy: GroupBy;
  density: number;
  edgeRouting: EdgeRouting;
  communityCollapse: boolean;
  camera?: CameraState;
  pinnedNodes?: Record<string, { x: number; y: number }>;
}
