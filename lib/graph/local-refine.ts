// Local refinement — THE core C1c invariant (spec → "Global layout stability",
// "Local refinement", Appendix A §C). Phase C1c Task 3.
//
// A HierarchicalLayout holds, per group, a STABLE reserved box origin (from the
// repository layout — these never move on a refinement) and a CACHED LOCAL LAYOUT in
// that box's parent-space frame. The world scene is assembled by projecting EACH group's
// local layout by ITS OWN box origin (localToWorld). Because a group's world geometry is
// a pure function of (its own local layout, its own box origin), committing a refinement
// — installing a new local layout for ONE group — can change only that group's contents:
// every OTHER group's boxes and node positions are byte-identical before and after.
// "Opening one directory must not move any other directory."
//
// This is layout ORCHESTRATION: it composes cached local layouts into a world scene and
// swaps one group's local layout atomically. No layout ALGORITHM runs here.
//
// INTEGRATION STATUS (Phase C1c): staged, unit-tested primitive — NOT yet wired into the
// scene pipeline or the layout worker (the canvas still renders via sceneBoxes). Until
// wiring lands, the byte-identical-siblings invariant is guarded only at the unit level
// (local-refine.test.ts), and the live relayout-on-material-change behavior is actually
// provided by scene.signature (scene.ts) + fitSignature (Explorer.tsx). When wiring this
// path, add a scene-level test that drives a real camera refinement through scene.ts and
// asserts non-refined groups' world positions + boxes are byte-identical end-to-end.

import {
  type CachedLocalLayout,
  type LocalLayoutCache,
  localToWorld,
  makeLocalLayoutCache,
  type ProxyCacheKey,
} from "./local-layout";
import type { ClusterBox, XYPosition } from "../layout";

/**
 * One group's stable reservation: its layout box key, the world-space `origin` of its
 * reserved box (fixed by the repository layout), the {@link ProxyCacheKey} its local
 * layout is cached under, and its `coarse` local layout (the proxy stand-in shown until
 * the group is refined). The origin and key are the group's identity in the world scene.
 */
export interface GroupReservation {
  boxKey: string;
  origin: XYPosition;
  key: ProxyCacheKey;
  coarse: CachedLocalLayout;
}

/**
 * The composed hierarchical layout: each group's stable box origin + the cache of
 * per-group local layouts + the group's CURRENTLY-ACTIVE cache key. Refinement swaps the
 * active local layout for ONE group (in its reserved box); the world scene is derived by
 * projecting every group's active local layout through its origin.
 */
export interface HierarchicalLayout {
  /** group box key → its stable reserved box origin (never moved by a refinement). */
  origins: Map<string, XYPosition>;
  /** group box key → the cache key its active local layout lives under. */
  activeKey: Map<string, ProxyCacheKey>;
  /** Deterministic group order (insertion order of reservations) for a stable scene. */
  order: string[];
  /** The per-group local-layout cache (shared with the rest of the C1c pipeline). */
  cache: LocalLayoutCache;
}

/**
 * Build a {@link HierarchicalLayout} from the stable group reservations. Each group's
 * coarse local layout is seeded into the cache under its key, so the initial world scene
 * shows every group as its proxy card. An optional shared `cache` lets the caller reuse
 * one cache across modes/recuts (else a fresh cache is made).
 */
export function makeHierarchicalLayout(
  reservations: readonly GroupReservation[],
  cache: LocalLayoutCache = makeLocalLayoutCache(),
): HierarchicalLayout {
  const origins = new Map<string, XYPosition>();
  const activeKey = new Map<string, ProxyCacheKey>();
  const order: string[] = [];
  for (const r of reservations) {
    origins.set(r.boxKey, r.origin);
    activeKey.set(r.boxKey, r.key);
    order.push(r.boxKey);
    cache.set(r.boxKey, r.key, r.coarse);
  }
  return { origins, activeKey, order, cache };
}

/**
 * Commit a refinement of ONE group: install `localLayout` (laid out WITHIN the group's
 * reserved box — local coordinates offset by the box origin) as the group's active local
 * layout under `key`, caching it. This touches ONLY the refined group's entry — no other
 * group's origin, key, or cached layout changes — so the next {@link worldScene} differs
 * only in that group's contents (the byte-identical-siblings guarantee). Atomic: the swap
 * is a single map write; a caller that rejects the refinement simply never calls this.
 */
export function refineGroup(
  layout: HierarchicalLayout,
  boxKey: string,
  localLayout: CachedLocalLayout,
  key: ProxyCacheKey,
): void {
  layout.cache.set(boxKey, key, localLayout);
  layout.activeKey.set(boxKey, key);
}

/** The assembled world scene: every group's positions + boxes in world space. */
export interface WorldScene {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}

/**
 * Assemble the world scene by projecting EACH group's active local layout through its own
 * stable box origin (localToWorld) and unioning the results, in the layout's deterministic
 * group order. A group's contribution depends only on its own (local layout, origin), so
 * the output for an unrefined group is identical regardless of what other groups did —
 * which is exactly what makes {@link refineGroup} a local operation.
 */
export function worldScene(layout: HierarchicalLayout): WorldScene {
  const positions = new Map<string, XYPosition>();
  const clusters: ClusterBox[] = [];
  for (const boxKey of layout.order) {
    const key = layout.activeKey.get(boxKey);
    const origin = layout.origins.get(boxKey);
    if (key === undefined || origin === undefined) continue;
    const local = layout.cache.get(boxKey, key);
    if (!local) continue;
    const world = localToWorld(local, origin);
    for (const [id, p] of world.positions) positions.set(id, p);
    for (const c of world.clusters) clusters.push(c);
  }
  return { positions, clusters };
}
