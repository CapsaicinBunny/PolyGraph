// CompactGroupingSnapshot — the worker-bound, typed-array columnar projection of a
// GroupingHierarchy (spec → "Grouping & collapse" / "Compact grouping snapshot").
//
// A GroupingHierarchy (grouping.ts) answers "which nodes belong together?" via small
// object methods (roots/childrenOf/nodesOf/groupOfNode). That is convenient on the
// main thread but the WRONG shape to hand a Web Worker on a 1.3M-node graph: a
// Record<NodeOrdinal, GroupId[]> would be ~1.3M arrays. This module flattens a
// hierarchy into a handful of parallel arrays sized by the number of GROUPS (small),
// plus one Uint32Array sized by the number of NODES holding each node's *direct*
// group ordinal (or NO_GROUP). The ancestor PATH of a group is derived by walking
// `parentByGroup` — never stored per node.
//
// Pure; the result is structured-clone- and JSON-round-trippable (the typed arrays
// transfer to the worker; durable workspace copies may serialize as plain arrays).

import type { GroupingHierarchy } from "./grouping";
import type { GroupId } from "./collapse-model";

/**
 * Sentinel for a node with no group — excluded by `missing.group==="exclude"`,
 * eligibility, filtering, or malformed provider data. `0xffff_ffff` so it can never
 * collide with a real group ordinal (Uint32Array max real index is far below it).
 */
export const NO_GROUP = 0xffffffff;

/**
 * The columnar grouping snapshot. Group-sized arrays (`groupIds`/`groupLabels`/
 * `parentByGroup`/`depthByGroup`/`boxKeyByGroup`) are tiny; only `directGroupByNode`
 * is node-sized. Worker-bound via the typed arrays; the string arrays travel
 * alongside (structured-clone). See spec "Compact grouping snapshot".
 */
export interface CompactGroupingSnapshot {
  /** The grouping mode this snapshot is for (e.g. "directory", "facet:env"). */
  modeKey: string;
  /** group ordinal → namespaced group id (small: #groups, not #nodes). */
  groupIds: string[];
  /** group ordinal → human label (e.g. directory's last path segment). */
  groupLabels: string[];
  /** group ordinal → parent group ordinal, or -1 for a root. */
  parentByGroup: Int32Array;
  /** group ordinal → depth from a root (roots = 0). */
  depthByGroup: Uint16Array;
  /** group ordinal → the layout ClusterBox id (LOD/layout agreement key). */
  boxKeyByGroup: string[];
  /** node ordinal → its DIRECT group ordinal, or {@link NO_GROUP} if none. */
  directGroupByNode: Uint32Array;
  /** the root group ordinals (parent = -1). */
  roots: Uint32Array;
}

/**
 * Build the columnar snapshot from a GroupingHierarchy and the canonical node-id
 * order (the order `directGroupByNode` is keyed by — the consumer's node ordinals).
 *
 * Groups are enumerated by a deterministic DFS from `roots()`, children sorted by
 * namespaced id, so the group ordinals are stable for a given hierarchy regardless
 * of the hierarchy's internal child order. A node's direct group ordinal comes from
 * `groupOfNode`; a node whose group is null (or unknown to the enumeration) is
 * {@link NO_GROUP}.
 */
export function buildGroupingSnapshot(
  hierarchy: GroupingHierarchy,
  modeKey: string,
  nodeIds: readonly string[],
): CompactGroupingSnapshot {
  const groupIds: string[] = [];
  const groupLabels: string[] = [];
  const boxKeyByGroup: string[] = [];
  const parents: number[] = [];
  const depths: number[] = [];
  const rootOrdinals: number[] = [];
  // namespaced group id → its assigned ordinal (also the membership lookup below).
  const ordinalOf = new Map<GroupId, number>();

  const sortedIds = (ids: GroupId[]) => [...ids].sort();

  // Iterative DFS (explicit stack) so a deep hierarchy can't overflow. Each frame
  // carries the group id, its parent ordinal (-1 at a root), and its depth.
  const stack: { id: GroupId; parent: number; depth: number }[] = [];
  for (const rid of sortedIds(hierarchy.roots()).reverse()) {
    stack.push({ id: rid, parent: -1, depth: 0 });
  }
  while (stack.length > 0) {
    const { id, parent, depth } = stack.pop()!;
    if (ordinalOf.has(id)) continue; // a DAG-shaped hierarchy could revisit; first wins
    const ordinal = groupIds.length;
    ordinalOf.set(id, ordinal);
    groupIds.push(id);
    groupLabels.push(hierarchy.label(id));
    boxKeyByGroup.push(hierarchy.boxKey(id));
    parents.push(parent);
    depths.push(depth);
    if (parent === -1) rootOrdinals.push(ordinal);
    // Push children in reverse sorted order so they pop in sorted order.
    for (const cid of sortedIds(hierarchy.childrenOf(id)).reverse()) {
      stack.push({ id: cid, parent: ordinal, depth: depth + 1 });
    }
  }

  const directGroupByNode = new Uint32Array(nodeIds.length);
  for (let i = 0; i < nodeIds.length; i++) {
    const gid = hierarchy.groupOfNode(nodeIds[i]);
    const ord = gid != null ? ordinalOf.get(gid) : undefined;
    directGroupByNode[i] = ord ?? NO_GROUP;
  }

  return {
    modeKey,
    groupIds,
    groupLabels,
    parentByGroup: Int32Array.from(parents),
    depthByGroup: Uint16Array.from(depths),
    boxKeyByGroup,
    directGroupByNode,
    roots: Uint32Array.from(rootOrdinals),
  };
}

/**
 * The full group path of a group ordinal, outermost-first and INCLUDING the group
 * itself, derived by walking `parentByGroup` (paths are never stored per node — the
 * spec's core memory win). {@link NO_GROUP} yields `[]`.
 */
export function groupPath(snapshot: CompactGroupingSnapshot, ordinal: number): GroupId[] {
  if (ordinal === NO_GROUP) return [];
  const out: GroupId[] = [];
  let cur = ordinal;
  // Guard against a malformed cycle: stop after #groups steps.
  let guard = snapshot.groupIds.length + 1;
  while (cur !== -1 && guard-- > 0) {
    out.push(snapshot.groupIds[cur]);
    cur = snapshot.parentByGroup[cur];
  }
  out.reverse();
  return out;
}

/**
 * The strict ancestor group ordinals of a group ordinal, outermost-first (excludes
 * the group itself). {@link NO_GROUP} yields `[]`.
 */
export function ancestorGroupOrdinals(
  snapshot: CompactGroupingSnapshot,
  ordinal: number,
): number[] {
  if (ordinal === NO_GROUP) return [];
  const out: number[] = [];
  let cur = snapshot.parentByGroup[ordinal];
  let guard = snapshot.groupIds.length + 1;
  while (cur !== -1 && guard-- > 0) {
    out.push(cur);
    cur = snapshot.parentByGroup[cur];
  }
  out.reverse();
  return out;
}
