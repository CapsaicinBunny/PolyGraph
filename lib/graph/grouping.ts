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

// Re-exported so a consumer wiring directory grouping needs only this module for both
// the namespaced-id helpers and the GroupId type.
export type { GroupId };

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

/** Strip the directory namespace from a group id back to its bare layout/LOD path. */
export const directoryBoxKey = boxKeyOf;

/**
 * Every directory in the graph as a namespaced group id — the **safety universe** the
 * adaptive-LOD bootstrap layer closes (spec: LOD is "a budgeted cut through a hierarchy
 * of cached proxies", so everything starts closed and the cut/selection OPENS regions).
 * Excludes the synthetic root "" (not a group). Bare-path order from `dirIndex`.
 */
export function allDirectoryGroupIds(graph: GraphModel): Set<GroupId> {
  const out = new Set<GroupId>();
  for (const path of dirIndex(buildDirTree(graph)).keys()) out.add(directoryGroupId(path));
  return out;
}

/**
 * The strict ancestor directory group ids of a bare directory path, outermost-first:
 * "a/b/c" → ["directory:a", "directory:a/b"]. Used to seed the LOD selection so the
 * directories *above* the auto-collapse frontier render open (the frontier itself stays
 * the collapse boundary) — reproducing the seed exactly under the all-dirs bootstrap.
 */
export function ancestorDirectoryGroupIds(barePath: string): GroupId[] {
  const out: GroupId[] = [];
  let cur = "";
  for (const seg of barePath.split("/")) {
    if (!seg) continue;
    cur = cur ? `${cur}/${seg}` : seg;
    out.push(directoryGroupId(cur));
  }
  out.pop(); // drop the path itself — we want only its ancestors
  return out;
}

/** Map a set of bare directory paths to namespaced directory group ids. */
export function toDirectoryGroupIds(barePaths: Iterable<string>): Set<GroupId> {
  const out = new Set<GroupId>();
  for (const p of barePaths) out.add(directoryGroupId(p));
  return out;
}

/** Map a set of namespaced directory group ids back to bare layout/LOD paths. */
export function toDirectoryBoxKeys(groupIds: Iterable<GroupId>): Set<string> {
  const out = new Set<string>();
  for (const id of groupIds) out.add(boxKeyOf(id));
  return out;
}
