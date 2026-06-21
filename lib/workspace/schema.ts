// Serializable description of an Explorer session — the filters, layout,
// expansion, selection, and (best-effort) camera/pins that make a view
// reproducible. This is what "Save workspace" / "Export workspace JSON" writes
// and "Load workspace" reads. Sets are stored as arrays so it's plain JSON.

import type { ViewEdgeKind } from "../aggregate";
import type { FacetKey } from "../graph/dimensions";
import type { FacetSelection } from "../graph/facet-selection";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "../layout";
import type { FacetSelectionState } from "./facet-migrate";

export type EdgeRouting = "curved" | "orthogonal";

export interface WorkspaceFilters {
  showExternal: boolean;
  search: string;
  enabledEdgeKinds: string[];
  /**
   * Generic, sparse facet selections (kind/category/env/runtime/role + provider
   * facets) — the durable replacement for the old enabledNodeKinds/Categories/
   * Environments/Runtimes arrays. Keyed by facet key; only constraining entries
   * are stored. Old workspaces with the named arrays migrate on load
   * (facet-migrate.ts), so they still restore identically.
   */
  enabledFacets: Record<FacetKey, FacetSelectionState>;
  enabledFolders: string[];
  enabledLanguages: string[];
  /** @deprecated legacy named arrays — read on load for back-compat, never written. */
  enabledNodeKinds?: string[];
  /** @deprecated */
  enabledCategories?: string[];
  /** @deprecated */
  enabledEnvironments?: string[];
  /** @deprecated */
  enabledRuntimes?: string[];
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
  /** Sparse, registry-driven facet selections (runtime Set form). */
  enabledFacets: Map<FacetKey, FacetSelection>;
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
