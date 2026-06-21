// GroupingHierarchy — the mode-agnostic "which nodes belong together?" abstraction
// (spec → "Representation hierarchy & budgeted LOD": GroupingHierarchy answers
// *which nodes belong together*; a RepresentationHierarchy — a later phase — answers
// *at which levels can a group be rendered*). C1a ships ALL the peer modes:
// Directory, Package, Community, facet, and synthetic-None.
//
// Group ids are namespaced ("directory:<path>" / "package:<id>" / "community:<id>" /
// "facet:<key>:<value>" / "component:<id>") (spec "Namespaced group ids"), so one
// mode's ids can never collide with another's. `boxKey()` translates a namespaced
// group id to the layout's ClusterBox id — the LOD contract: scene/lod-cut/lod-scene
// measure boxes keyed by that id (see lib/layout/clusters.ts + lib/graph/lod-scene.ts
// sceneBoxes), so the hierarchy must round-trip to the exact key smart emits for that
// mode. Directory's boxKey is the BARE "<path>"; the flat modes' boxKey is the group
// node / community / value id smart clusters by.
//
// Built from buildDirTree / assignPackages / detectCommunities. Pure; no React.

import { buildDirTree, type DirNode, dirIndex } from "./hierarchy";
import type { GroupId } from "./collapse-model";
import type { DimensionDescriptor } from "./dimensions";
import { detectCommunities } from "../layout/community";
import { assignPackages } from "./levels/packages";
import type { PackageManifest } from "./levels/types";
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
  /** Human label for a group (e.g. the last path segment for a directory). */
  label(id: GroupId): string;
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
    // The directory's last path segment ("a/b/c" → "c"). The snapshot's groupLabels.
    label: (id) => {
      const path = boxKeyOf(id);
      const slash = path.lastIndexOf("/");
      return slash === -1 ? path : path.slice(slash + 1);
    },
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

// ─────────────────────────────────────────────────────────────────────────────
// Flat (single-level) hierarchies — Package / Community / facet.
//
// A *flat* hierarchy is the common shape for the non-directory modes: every group
// is a root with no children, and a node belongs to exactly one group (or none).
// `boxKey` is the bare id smart clusters by (so the cut measures the right box).
// ─────────────────────────────────────────────────────────────────────────────

/** Namespace prefixes for the non-directory modes. */
export const PACKAGE_NS = "package:";
export const COMMUNITY_NS = "community:";
export const COMPONENT_NS = "component:";
/** facet ids are "facet:<key>:<value>" — the prefix carries the dimension key. */
export const facetGroupId = (key: string, value: string): GroupId => `facet:${key}:${value}`;

/** Strip a known namespace prefix from a group id, returning the bare remainder. */
function stripPrefix(id: GroupId, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Build a flat GroupingHierarchy from a node→bareId assignment. `idOf` maps a node id
 * to its bare group id (the layout ClusterBox key) or null; `nsOf` namespaces a bare
 * id; `bareOf` is the inverse (for boxKey); `labelOf` is the human label of a bare id.
 */
function flatGrouping(
  graph: GraphModel,
  idOf: (nodeId: string) => string | null,
  nsOf: (bare: string) => GroupId,
  bareOf: (id: GroupId) => string,
  labelOf: (bare: string) => string,
): GroupingHierarchy {
  // node id → namespaced group id; and the set of groups that actually have members.
  const groupByNode = new Map<string, GroupId>();
  const members = new Map<GroupId, string[]>();
  for (const n of graph.nodes) {
    const bare = idOf(n.id);
    if (bare == null) continue;
    const gid = nsOf(bare);
    groupByNode.set(n.id, gid);
    (members.get(gid) ?? members.set(gid, []).get(gid))!.push(n.id);
  }
  const rootIds = [...members.keys()];

  return {
    roots: () => [...rootIds],
    childrenOf: () => [], // flat: no nesting
    nodesOf: (id) => [...(members.get(id) ?? [])],
    groupOfNode: (nodeId) => groupByNode.get(nodeId) ?? null,
    boxKey: bareOf,
    label: (id) => labelOf(bareOf(id)),
  };
}

/**
 * Package grouping: every node belongs to the package that owns its file (via the
 * manifest resolver in lib/graph/levels/packages). Flat. The bare group id is the
 * package NODE id (`pkg:<id>` / `pkg:ext:<label>` / `pkg:«root»`), which is exactly
 * the id smart's package-mode ClusterBox carries — so the cut measures it.
 */
export function packageGrouping(
  graph: GraphModel,
  manifests: PackageManifest[],
): GroupingHierarchy {
  const { packageOf, packageNodes } = assignPackages(graph, manifests);
  const labelOf = (bare: string) => packageNodes.get(bare)?.label ?? bare;
  return flatGrouping(
    graph,
    (nodeId) => packageOf.get(nodeId) ?? null,
    (bare) => PACKAGE_NS + bare,
    (id) => stripPrefix(id, PACKAGE_NS),
    labelOf,
  );
}

/**
 * Community grouping: label-propagation communities over the graph. Flat. Singleton
 * communities are left UNGROUPED (`groupOfNode` → null) — mirroring smart's "leave
 * singleton communities at the root" so the view isn't a sea of one-node boxes. The
 * bare group id is the community id (`"Community N"`), the id smart clusters by.
 */
export function communityGrouping(
  graph: GraphModel,
  communityOf?: Map<string, string>,
): GroupingHierarchy {
  const community =
    communityOf ??
    detectCommunities(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
  // Size communities over the graph's nodes so singletons can be dropped.
  const sizes = new Map<string, number>();
  for (const n of graph.nodes) {
    const c = community.get(n.id);
    if (c) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  }
  return flatGrouping(
    graph,
    (nodeId) => {
      const c = community.get(nodeId);
      return c && (sizes.get(c) ?? 0) > 1 ? c : null;
    },
    (bare) => COMMUNITY_NS + bare,
    (id) => stripPrefix(id, COMMUNITY_NS),
    (bare) => bare,
  );
}

/**
 * Resolve a single containment value for a node under a facet descriptor's
 * FacetGrouping (spec "Multi-valued facet grouping"). Returns the bare group value,
 * or null when the node has no value (→ unclassified). Multi-valued+disabled is NOT
 * groupable — `facetGrouping` returns null for the whole mode, never reaching here.
 */
function facetValueOf(values: string[], grouping: DimensionDescriptor["grouping"]): string | null {
  if (values.length === 0) return null;
  switch (grouping.mode) {
    case "single":
      return values[0];
    case "primary":
      // "first" = first stored; "priority" without a declared priority list also
      // falls to the first (a later phase can thread a priority order through).
      return values[0];
    case "combination":
      // One synthetic group per value-SET: sort+join so {node,bun} === {bun,node}.
      return [...values].sort().join("+");
    default:
      return null; // disabled — unreachable (guarded in facetGrouping)
  }
}

/**
 * Facet grouping: group by a chosen groupable facet dimension using its FacetGrouping
 * (single / primary / combination). Flat. A multi-valued facet whose grouping is
 * `disabled` is NOT groupable → returns null (the mode is not offered). A node with no
 * value for the facet is unclassified (`groupOfNode` → null), per `missing.group`. The
 * bare group id is the namespaced "facet:<key>:<value>" itself (a facet group is its
 * own layout ClusterBox — boxKey is the id verbatim).
 */
export function facetGrouping(
  graph: GraphModel,
  descriptor: DimensionDescriptor,
): GroupingHierarchy | null {
  if (descriptor.grouping.mode === "disabled") return null;
  const key = descriptor.key;
  // Precompute node id → its value group once (avoid an O(N) find per node).
  const valueByNode = new Map<string, string>();
  for (const n of graph.nodes) {
    const stored = n.facets?.[key];
    const values =
      stored && stored.length > 0
        ? stored
        : descriptor.defaultValue !== undefined
          ? [descriptor.defaultValue]
          : [];
    const v = facetValueOf(values, descriptor.grouping);
    if (v != null) valueByNode.set(n.id, v);
  }
  return flatGrouping(
    graph,
    (nodeId) => valueByNode.get(nodeId) ?? null,
    (value) => facetGroupId(key, value),
    (id) => id, // boxKey is the full namespaced id (the facet ClusterBox key)
    // label: the value (the trailing segment of "facet:<key>:<value>").
    (bare) => {
      const prefix = `facet:${key}:`;
      return bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
    },
  );
}

/**
 * Synthetic-None grouping: the **safety hierarchy** for "Group by: None" (spec
 * "Group by: None keeps an internal hierarchy"). None has no visible containers, but
 * a 100k-node repo must not bypass the render budget — so we build a reduction
 * hierarchy of connected components → communities. EVERY node (including isolated
 * ones and nodes the *semantic* facet hierarchy would leave unclassified) gets a
 * representation path here: a node lands in a community group whose root is its
 * connected component. The bare ids are internal ("component:<i>" / "community:<i>:<c>")
 * — None renders no boxes, so these never need to match a smart ClusterBox.
 */
export function syntheticNoneGrouping(graph: GraphModel): GroupingHierarchy {
  const ids = graph.nodes.map((n) => n.id);
  const componentOf = connectedComponentIds(ids, graph.edges);
  // Communities within the whole graph; isolated/own-community nodes still get one.
  const communityOf = detectCommunities(ids, graph.edges);

  // node id → its leaf (community) group, namespaced under its component root.
  const groupByNode = new Map<string, GroupId>();
  const parentOf = new Map<GroupId, GroupId | null>();
  const labelByGroup = new Map<GroupId, string>();
  const childrenByGroup = new Map<GroupId, Set<GroupId>>();
  const rootSet = new Set<GroupId>();
  const membersByGroup = new Map<GroupId, string[]>();

  for (const n of graph.nodes) {
    const comp = componentOf.get(n.id) ?? n.id;
    const comm = communityOf.get(n.id) ?? n.id;
    const compId = COMPONENT_NS + comp;
    const commId = `${COMMUNITY_NS}${comp}:${comm}`; // community scoped by component
    if (!parentOf.has(compId)) {
      parentOf.set(compId, null);
      rootSet.add(compId);
      labelByGroup.set(compId, comp);
      childrenByGroup.set(compId, new Set());
    }
    if (!parentOf.has(commId)) {
      parentOf.set(commId, compId);
      labelByGroup.set(commId, comm);
      childrenByGroup.get(compId)!.add(commId);
    }
    groupByNode.set(n.id, commId);
    (membersByGroup.get(commId) ?? membersByGroup.set(commId, []).get(commId))!.push(n.id);
  }

  return {
    roots: () => [...rootSet],
    childrenOf: (id) => [...(childrenByGroup.get(id) ?? [])],
    nodesOf: (id) => [...(membersByGroup.get(id) ?? [])],
    groupOfNode: (nodeId) => groupByNode.get(nodeId) ?? null,
    // Internal-only ids; boxKey returns the id verbatim (no smart ClusterBox uses it).
    boxKey: (id) => id,
    label: (id) => labelByGroup.get(id) ?? id,
  };
}

/**
 * Connected-component id per node (edges undirected) via union-find. Returns a map
 * nodeId → the component representative (the smallest member id, for stability).
 */
function connectedComponentIds(
  ids: string[],
  edges: { source: string; target: string }[],
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue;
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // union, smaller id wins
  }
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, find(id));
  return out;
}
