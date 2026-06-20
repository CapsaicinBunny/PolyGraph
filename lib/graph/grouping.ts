// GroupingHierarchy — the mode-agnostic "which nodes belong together?" abstraction
// (spec → "Representation hierarchy & budgeted LOD": GroupingHierarchy answers
// *which nodes belong together*; a RepresentationHierarchy — a later phase — answers
// *at which levels can a group be rendered*). C0 ships the **Directory** implementation
// only; Community / facet / synthetic-None arrive in C1a.
//
// Group ids are namespaced "directory:<path>" (spec "Namespaced group ids"), so a
// later mode's ids can never collide with directory ids. `boxKey()` translates a
// namespaced group id back to the BARE "<path>" that the layout's ClusterBox id uses
// — the LOD contract: scene/lod-cut/lod-scene measure boxes keyed by bare directory
// path (see lib/layout/clusters.ts buildClusterTree + lib/graph/lod-scene.ts
// sceneBoxes), so the hierarchy must round-trip to that exact key.
//
// Built from buildDirTree (lib/graph/hierarchy.ts). Pure; no React.

import { buildDirTree, type DirNode, dirIndex } from "./hierarchy";
import type { GroupId } from "./collapse-model";
import type { GraphModel } from "./types";

/** Namespace prefix for directory group ids. */
export const DIRECTORY_NS = "directory:";

/** Wrap a bare directory path as a namespaced group id: "a/b" → "directory:a/b". */
export const directoryGroupId = (path: string): GroupId => DIRECTORY_NS + path;

/**
 * A grouping hierarchy: the tree of groups a grouping mode imposes on the graph, plus
 * the node ↔ group membership and the layout box-key translation. Mode-agnostic — the
 * Directory implementation is one of several (Package / Community / facet / None come
 * later); every implementation namespaces its ids so modes never collide.
 */
export interface GroupingHierarchy {
  /** Top-level group ids (namespaced). */
  roots(): GroupId[];
  /** Immediate child group ids of a group (namespaced); empty for leaves/unknowns. */
  childrenOf(id: GroupId): GroupId[];
  /** Node ids belonging *directly* to this group (not its descendants). */
  nodesOf(id: GroupId): string[];
  /** The group a node belongs to directly, or null if it has none (e.g. a root file). */
  groupOfNode(nodeId: string): GroupId | null;
  /** The bare layout ClusterBox id for this group — the LOD/layout agreement key. */
  boxKey(id: GroupId): string;
}

/**
 * Build the Directory grouping hierarchy from a graph. Groups are directories; a node
 * belongs to the directory directly containing its file. Root-level files (no
 * directory) have no group — `groupOfNode` returns null and they are never a root.
 */
export function directoryGrouping(graph: GraphModel): GroupingHierarchy {
  const root = buildDirTree(graph);
  const byPath: Map<string, DirNode> = dirIndex(root);

  // Node id → its directly-containing directory group id. Only file nodes are members
  // (the dir tree is built from file nodes); a root-level file maps to "" → no group.
  const groupByNode = new Map<string, GroupId>();
  for (const node of byPath.values()) {
    const gid = directoryGroupId(node.path);
    for (const fileId of node.files) groupByNode.set(fileId, gid);
  }

  return {
    roots: () => root.children.map((c) => directoryGroupId(c.path)),
    childrenOf: (id) => {
      const node = byPath.get(boxKeyOf(id));
      return node ? node.children.map((c) => directoryGroupId(c.path)) : [];
    },
    nodesOf: (id) => {
      const node = byPath.get(boxKeyOf(id));
      return node ? [...node.files] : [];
    },
    // Unknown id, a symbol, or a root file (the synthetic root "" is not a group) all
    // have no directory group → null.
    groupOfNode: (nodeId) => groupByNode.get(nodeId) ?? null,
    boxKey: boxKeyOf,
  };
}

/** Strip the directory namespace: "directory:a/b" → "a/b". The LOD/layout box key. */
function boxKeyOf(id: GroupId): string {
  return id.startsWith(DIRECTORY_NS) ? id.slice(DIRECTORY_NS.length) : id;
}
