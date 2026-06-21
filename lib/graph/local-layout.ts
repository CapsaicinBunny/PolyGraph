// Cached local layouts — the data half of "Global layout stability" (spec →
// "Global layout stability" + Appendix A §C/§H). Phase C1c Task 2.
//
// Each group owns a CACHED LOCAL LAYOUT expressed in PARENT-space (local coordinates
// whose origin is the group's reserved box). Refining a group lays its children WITHIN
// its reserved box; the layout is local so opening one directory never moves any other —
// world positions are derived by offsetting a group's local layout by its box origin
// (`localToWorld`), so a sibling's world coordinates are a pure function of ITS OWN box.
//
// The cache is keyed by a ProxyCacheKey carrying every input a local layout depends on
// (Appendix A §H): a cached layout is reusable only when ALL parts match, so changing the
// layout DIRECTION, card METRICS, FILTER signature, or grouping SEMANTICS invalidates it.
// The key is serialized canonically (fixed field order) so it is insensitive to object
// property insertion order — the same robustness the scene layout signature has.
//
// Pure data structures; no React, no GPU, no layout ALGORITHM (this is orchestration).
//
// INTEGRATION STATUS (Phase C1c): staged, unit-tested primitive — NOT yet wired. No live
// path constructs a ProxyCacheKey from real scene inputs yet (only local-refine.ts and
// tests reference this), so the cache-invalidation guarantee is proven only against
// hand-built keys. When wiring lands, add a test that builds a ProxyCacheKey from the
// real scene-signature inputs so this key's field set and scene.signature cannot drift.

import type { ClusterBox, LayoutDirection, XYPosition } from "../layout";

/**
 * Everything a cached local layout depends on (Appendix A §H "ProxyCacheKeyParts"). A
 * cached layout/proxy is reusable ONLY when every part matches — so a direction flip,
 * a node-style metrics bump, an edge-filter change, or a grouping-semantics change all
 * invalidate it. `representationId` ties the entry to a specific rep in the hierarchy;
 * the rest are graph/analysis-wide signatures the caller already computes for the scene.
 */
export interface ProxyCacheKey {
  graphVersion: string;
  filterSignature: string;
  groupingMode: string;
  groupingVersion: string;
  layoutEngine: string;
  layoutDirection: LayoutDirection;
  layoutOptionsHash: string;
  nodeStyleMetricsVersion: string;
  edgeKindsSignature: string;
  representationId: number;
  representationBuilderVersion: string;
}

/**
 * A group's local layout in PARENT-space (the reserved box's local coordinate frame,
 * origin at the box's top-left). `positions` are child node top-lefts; `clusters` are
 * nested container boxes; `width`/`height` are the laid-out content extent. Offset into
 * world space by {@link localToWorld}. The same shape a layout engine produces, minus the
 * world placement — so a refinement reuses the engine output verbatim.
 */
export interface CachedLocalLayout {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
  width: number;
  height: number;
}

// The canonical field order the serializer walks. Declared once so add/remove of a part
// is a single edit and the order can never drift between equality and serialization.
const KEY_FIELDS: readonly (keyof ProxyCacheKey)[] = [
  "graphVersion",
  "filterSignature",
  "groupingMode",
  "groupingVersion",
  "layoutEngine",
  "layoutDirection",
  "layoutOptionsHash",
  "nodeStyleMetricsVersion",
  "edgeKindsSignature",
  "representationId",
  "representationBuilderVersion",
];

/**
 * Canonical string form of a {@link ProxyCacheKey}: each part in a FIXED order, so it is
 * insensitive to object property insertion order (two keys with the same values always
 * serialize identically). The cache uses this as its map key.
 */
export function serializeProxyCacheKey(key: ProxyCacheKey): string {
  let out = "";
  for (const f of KEY_FIELDS) out += `${f}=${String(key[f])} `;
  return out;
}

/** Structural equality of two {@link ProxyCacheKey}s across every part. */
export function proxyCacheKeyEquals(a: ProxyCacheKey, b: ProxyCacheKey): boolean {
  for (const f of KEY_FIELDS) if (a[f] !== b[f]) return false;
  return true;
}

/**
 * A cache of per-group local layouts, keyed by `(groupBoxKey, ProxyCacheKey)`. Two groups
 * may share an identical key (e.g. on the same scan) yet own DIFFERENT local layouts, so
 * the group box key is part of the cache identity. The ProxyCacheKey half ensures a stale
 * layout is never served across a material change (direction/metrics/filter/grouping).
 */
export interface LocalLayoutCache {
  /** The cached local layout for a group under a key, or undefined on a miss. */
  get(groupBoxKey: string, key: ProxyCacheKey): CachedLocalLayout | undefined;
  /** Store (or replace) a group's local layout under a key. */
  set(groupBoxKey: string, key: ProxyCacheKey, layout: CachedLocalLayout): void;
  /** Drop a group's entry for a specific key (no-op if absent). */
  delete(groupBoxKey: string, key: ProxyCacheKey): void;
  /** Number of cached entries. */
  readonly size: number;
  /** Drop everything (e.g. on a material relayout). */
  clear(): void;
}

/** The composite map key: group box key + the canonical ProxyCacheKey serialization. */
function entryKey(groupBoxKey: string, key: ProxyCacheKey): string {
  // A newline separates the two halves; it can't appear in a box-key path or in a
  // serialized "field=value " part, so the join is unambiguous (no group/key collision).
  return `${groupBoxKey}\n${serializeProxyCacheKey(key)}`;
}

/** Build an empty {@link LocalLayoutCache} (a thin Map wrapper over the composite key). */
export function makeLocalLayoutCache(): LocalLayoutCache {
  const map = new Map<string, CachedLocalLayout>();
  return {
    get(groupBoxKey, key) {
      return map.get(entryKey(groupBoxKey, key));
    },
    set(groupBoxKey, key, layout) {
      map.set(entryKey(groupBoxKey, key), layout);
    },
    delete(groupBoxKey, key) {
      map.delete(entryKey(groupBoxKey, key));
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}

/** A group's local layout projected into world space (positions + boxes + extent). */
export interface WorldLocalLayout {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
  width: number;
  height: number;
}

/**
 * Project a cached local layout (parent-space) into world space by offsetting every child
 * position and nested cluster box by the reserved box's world `origin`. Pure — the source
 * local layout is NOT mutated, so the same cached layout can be re-projected against any
 * box origin. This is the function that makes refinement local: a group's world geometry
 * depends only on ITS OWN local layout + ITS OWN box origin, never on a sibling.
 */
export function localToWorld(layout: CachedLocalLayout, origin: XYPosition): WorldLocalLayout {
  const positions = new Map<string, XYPosition>();
  for (const [id, p] of layout.positions)
    positions.set(id, { x: p.x + origin.x, y: p.y + origin.y });
  const clusters = layout.clusters.map((c) => ({ ...c, x: c.x + origin.x, y: c.y + origin.y }));
  return { positions, clusters, width: layout.width, height: layout.height };
}
