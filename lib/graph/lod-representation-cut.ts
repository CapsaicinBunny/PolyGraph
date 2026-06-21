// The scene bridge for the representation-LOD cut (Phase C1b Task 5). Connects the
// constrained budgeted antichain solver (lod-cut-solver.ts) to the EXISTING collapse-
// shaped render pipeline (compose() → collapseClusters()), so the rendered scene becomes
// "the committed cut's selected representations" WITHOUT rewriting the renderer or scene
// builder — and the C1a collapse path stays the untouched fallback when adaptiveLod is
// off (the canvas chooses which path to run).
//
// Flow (all pure):
//   1. Build a RepresentationHierarchy from the active mode's grouping snapshot.
//   2. Populate each group proxy's world bounds from the LIVE scene boxes (by boxKey), so
//      the solver's visibility weighting and the screen-size refine gate see what the user
//      sees — the same coordinate space the C1a cut measured.
//   3. Translate user intent into solver CONSTRAINTS (forceClosed/forceOpen) and the
//      camera/legibility cutoff into a refine GATE (off-screen or sub-openPx proxies are
//      not auto-refined — matching "coarse zoom shows proxies").
//   4. solveLodCut → a valid antichain; commit it through the LOD runtime (only a
//      materially-different cut bumps the generation).
//   5. Derive the COLLAPSED box-key set (the box keys of selected proxy reps) so the result
//      drops into groupLodSelection / compose() exactly like the C1a cut.
//
// A selected hidden node maps to its active proxy's box key (for the highlight) via
// representativeOf.

import type { CompactGroupingSnapshot } from "./grouping-snapshot";
import { NO_GROUP } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import { intersectsViewport, screenHeight, worldToScreen } from "./lod-screen";
import {
  buildRepresentationEdgeIndex,
  buildRepresentationHierarchy,
  DETACHED_REP,
  type EdgeIndexInput,
  type RepresentationEdgeIndex,
  type RepresentationHierarchy,
  representationBuilderVersion,
  representationEdgeIndexVersion,
  representativeOf,
} from "./representation";
import {
  computeStableProxyBounds,
  PROXY_LAYOUT_VERSION,
  type StableProxyBounds,
} from "./representation-proxy-layout";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  cutSignature,
  type LimitedDetail,
  LOD_BUDGET,
  type LodBudget,
  type LodCut,
  makeRuntimeCut,
  type RuntimeLodCut,
  type SolveDiagnostics,
  solveLodCut,
} from "./lod-cut-solver";
import {
  commitIfMaterial,
  createLodRuntime,
  type LodRuntimeState,
  setPending,
} from "./lod-runtime";
import { type EvictionController, makeEvictionController } from "./lod-eviction";
import type { CollapseIntent, GroupId } from "./collapse-model";

/**
 * Version of the representation BUILDER (the hierarchy shape: proxy parenting, the bootstrap
 * super-root / root-bucket tiering, intermediate tiers, fan-out bounds, cost rollup). Folded
 * into the {@link RepresentationMaterialSignature} so a builder change invalidates every cached
 * {@link RepresentationRuntime} (and downstream proxy/local-layout caches keyed off the same
 * version). Re-exports {@link representationBuilderVersion} (the single source of truth defined
 * alongside the builder) so the two can never drift; bump THAT constant on any change to the
 * structure `buildRepresentationHierarchy` emits — including the intermediate-tier limits.
 */
export const REPRESENTATION_BUILDER_VERSION = representationBuilderVersion;

/**
 * Version of the persistent CSR edge index (design B2 + impl note (a)). Folded into the
 * {@link RepresentationMaterialSignature} alongside {@link REPRESENTATION_BUILDER_VERSION} so a
 * change to the index layout / pairing rule invalidates every cached {@link RepresentationRuntime}
 * (the index is cached ON the runtime, on the SAME signature). Re-exports the single source of
 * truth from the edge-index module; it already concatenates the hierarchy builder version.
 */
export const REPRESENTATION_EDGE_INDEX_VERSION = representationEdgeIndexVersion;

/** Tuning for the representation cut, mirroring the C1a GroupCutOptions surface. */
export interface RepLodOptions {
  /** Minimum on-screen box height (px) for a proxy to auto-refine into its children. */
  openPx: number;
  /** Soft cap on rendered cards (auto refinement stays under this). */
  maxCards: number;
  /** Layout-node budget (the hard ceiling on the cut's rendered node cost). */
  nodeBudget: number;
  /** Viewport cull margin (px). */
  margin: number;
  /** Layout-node cost of one underlying node (default 1 = a card). */
  nodeCost?: (nodeId: string) => number;
}

/** Conservative defaults aligned with the canvas's LOD constants. */
export const DEFAULT_REP_LOD_OPTIONS: RepLodOptions = {
  openPx: 240,
  maxCards: 800,
  nodeBudget: 2500,
  margin: 0,
};

export interface RepLodInput {
  snapshot: CompactGroupingSnapshot;
  nodeIds: readonly string[];
  /**
   * POST-FILTER visibility mask over node ordinals (Gap 7 — "Cut is not clearly
   * post-filter"). Returns false for a node hidden by the active filters (folders,
   * languages, edge kinds, query filter). When provided, the cut is built from the
   * post-filter projection: hidden nodes' leaf reps are DETACHED — they add no proxy-subtree
   * cost, no card-budget pressure, and a group with no visible members produces no proxy.
   * Omitted → every node visible (the prior raw-graph behavior). The already-filtered
   * community detection is reused via the snapshot; it is NOT re-run over the full graph.
   */
  visibleNode?: (ordinal: number) => boolean;
  /**
   * POST-FILTER edges by node ORDINAL (design B2 + impl note (a)). When provided, a persistent
   * CSR {@link RepresentationEdgeIndex} is built ALONGSIDE the hierarchy and cached on the SAME
   * material signature ({@link RepresentationRuntime.edgeIndex}) — a camera recut reuses it,
   * only a material change rebuilds it. The index drives the solver's cut-aware marginal edge
   * cost and the incremental materializer's boundary-edge retrieval (Gap 9). Hidden endpoints
   * (per {@link visibleNode}, reflected in the hierarchy's detachment) are dropped. Omitted →
   * no index is built (the legacy behavior; the additive per-rep edge cost stands in).
   */
  edges?: readonly EdgeIndexInput[];
  /** Live scene boxes per layout box key (open ClusterBoxes + collapsed aggregate cards). */
  boxes: Map<string, Box>;
  cam: Camera;
  vp: Viewport;
  /** User collapse intent for the active mode (group id → open/closed). */
  intent: CollapseIntent;
  options: RepLodOptions;
  /** The previous committed runtime (to gate the generation); omitted on the first solve. */
  previous?: LodRuntimeState;
  /** Filter signature folded into the CutSignature (a filter change forces a commit). */
  filterSignature?: string;
  /**
   * Identity of the FILTERED graph this cut is built over (graph version + filter
   * signature, or any caller token that changes iff the post-filter node/edge SET changes).
   * Folded into the {@link RepresentationMaterialSignature}: when it (and the grouping /
   * node-cost inputs) are unchanged, a recut REUSES the cached hierarchy rather than
   * rebuilding it (Gap 4). Omitted → derived from `filterSignature` alone (no graph-version
   * component — adequate for tests, but a production caller should pass the real identity).
   */
  filteredGraphId?: string;
  /**
   * Monotonic version of the active grouping (bumps when the grouping is recomputed, even
   * if the mode string is unchanged — e.g. a re-run community detection relabels). Folded
   * into the material signature so a regrouping rebuilds the hierarchy. Omitted → 0.
   */
  groupingVersion?: number;
  /**
   * Signature of the per-node COST inputs (the `nodeCost` closure's domain — e.g. the
   * expanded-files set + symbol counts). When the costs change the hierarchy's rolled-up
   * subtree costs change, so this is folded into the material signature. Omitted → "" (the
   * caller asserts the cost function is stable for the cached runtime's lifetime).
   */
  nodeCostSignature?: string;
  /** Collect the solver's why-not-refined diagnostics (Appendix A §I observability). */
  collectDiagnostics?: boolean;
  /**
   * The persistent eviction + runtime-cut controller (Phase C1c bug b). When provided, the
   * cut's auto-opened (non-forced) group proxies are tracked across recuts; offscreen ones
   * over the controller's budget are EVICTED — re-collapsed via an extra forceClosed pass —
   * so a long exploration of many regions can't grow auto-opens without bound. The
   * controller also rolls the runtime cut in place (no fresh array per recut). Omitted →
   * the legacy behavior (a fresh runtime cut each call, no eviction).
   */
  eviction?: EvictionController;
  /**
   * A pre-acquired persistent runtime (Gap 4). When provided, the cut is computed AGAINST
   * this runtime's cached hierarchy / node ordinals / group-id map rather than rebuilding
   * them — a camera recut UPDATES bounds/priorities/cut but does NOT reconstruct the
   * hierarchy. The caller obtains it via {@link acquireRepresentationRuntime}, which reuses
   * the prior runtime when the material signature is unchanged and rebuilds it when it
   * changes. Omitted → the legacy behavior (a fresh hierarchy + group-id map every call).
   */
  runtime?: RepresentationRuntime;
}

/**
 * The PERSISTENT representation runtime (design Gap 4 — "Hierarchy rebuilt on every recut").
 * Everything whose shape is a function of the MATERIAL signature (filtered-graph identity +
 * grouping mode/version + node-cost inputs + builder version) — NOT of the camera — lives
 * here and is reused across camera recuts. A recut updates per-rep bounds / priorities and
 * re-solves the cut; it never rebuilds these O(N) structures. The runtime is rebuilt only
 * when {@link materialSignature} changes (see {@link acquireRepresentationRuntime}).
 */
export interface RepresentationRuntime {
  /** The material signature this runtime was built under (the reuse/rebuild key). */
  signature: RepresentationMaterialSignature;
  /** The proxy hierarchy (arrays, subtree-cost rollups, DFS intervals) — built ONCE. */
  hierarchy: RepresentationHierarchy;
  /**
   * STABLE, layout-INDEPENDENT proxy box geometry (design Gap 3 / P2 "stable-proxy-geometry").
   * A deterministic hierarchical layout over the hierarchy STRUCTURE — computed ONCE here,
   * independent of the visual node-layout engine. The cut overwrites the hierarchy's live
   * `bounds*` columns from the engine's scene boxes each recut; when an engine emits NO box for a
   * rep (Grid, the classic engines, None), the cut falls back to THIS geometry so it still has
   * bounds to measure. That fallback is what makes the cut OPERATE with every engine — not merely
   * ignore the engine name. A function of the material signature, so it is cached on the runtime
   * and reused across camera recuts; a material change rebuilds it with the hierarchy.
   */
  stableBounds: StableProxyBounds;
  /**
   * The persistent CSR edge index (design B2 + impl note (a)), built ONCE alongside the
   * hierarchy from the post-filter edges, or `undefined` when the caller supplied no `edges`.
   * Reused across camera recuts (it is a function of the material signature, not the camera);
   * a material change rebuilds it together with the hierarchy.
   */
  edgeIndex: RepresentationEdgeIndex | undefined;
  /** The canonical node-id order the hierarchy was built from (reused, not re-mapped). */
  nodeIds: readonly string[];
  /** namespaced group id → rep id, built once with the hierarchy (used for intent → constraints). */
  repOfGroupId: Map<GroupId, number>;
  /** The persistent eviction + runtime-cut controller (bounds offscreen auto-opens; rolls the cut). */
  eviction: EvictionController;
  /** The committed-generation runtime (pending/committed cut + generation), persisted across recuts. */
  lodRuntime: LodRuntimeState | undefined;
}

/** The opaque material-signature string keying a {@link RepresentationRuntime}. */
export type RepresentationMaterialSignature = string;

/**
 * Compute the MATERIAL signature for the cached runtime (Gap 4): the conjunction of inputs
 * whose change requires REBUILDING the hierarchy — the filtered-graph identity, the grouping
 * mode + version, the node-cost inputs, and the builder version. The camera, intent, and
 * live boxes are DELIBERATELY excluded — they drive a recut, not a rebuild.
 */
export function materialSignature(input: RepLodInput): RepresentationMaterialSignature {
  const graphId = input.filteredGraphId ?? input.filterSignature ?? "";
  const mode = input.snapshot.modeKey;
  const groupingVersion = input.groupingVersion ?? 0;
  const nodeCostSig = input.nodeCostSignature ?? "";
  // Stable, FIXED-order parts so the signature never drifts with object key order.
  return [
    `g=${graphId}`,
    `m=${mode}`,
    `gv=${groupingVersion}`,
    `nc=${nodeCostSig}`,
    `b=${REPRESENTATION_BUILDER_VERSION}`,
    `e=${REPRESENTATION_EDGE_INDEX_VERSION}`,
    `pl=${PROXY_LAYOUT_VERSION}`,
  ].join("|");
}

/**
 * Acquire the persistent runtime for `input` (Gap 4). When `previous` exists and its
 * signature MATCHES the input's material signature, it is REUSED verbatim — the same
 * hierarchy object, node ordinals, group-id map and eviction controller (a camera recut
 * never reconstructs them). Otherwise a fresh runtime is built: the hierarchy + group-id
 * map are constructed once here, a right-sized eviction controller is created, and the
 * committed-generation runtime is carried over only when `previous` exists for the same
 * grouping mode (else a fresh generation chain starts).
 *
 * The returned runtime is passed to {@link buildSceneRepresentationCut} on `input.runtime`.
 */
export function acquireRepresentationRuntime(
  input: RepLodInput,
  previous?: RepresentationRuntime,
  offscreenOpenBudget = DEFAULT_OFFSCREEN_OPEN_BUDGET,
): RepresentationRuntime {
  const signature = materialSignature(input);
  if (previous && previous.signature === signature) {
    // MATERIAL match → reuse the cached hierarchy / ordinals / group-id map / eviction /
    // generation runtime unchanged. This is the hot path of a camera recut.
    return previous;
  }

  // Material change (or first build) → reconstruct the O(N) structures ONCE.
  const nodeCost = input.options.nodeCost ?? (() => 1);
  // P0.5 normalization (design B1): ALWAYS build with the synthetic super-root / root-bucket
  // tier and the render-only intermediate tiers. This is what makes the bootstrap (coarsest)
  // cut budget-feasible regardless of orphan count and gives every oversized group bounded
  // intermediate antichains to refine through — the precondition for "every group can
  // progressively refine" in EVERY mode, including synthetic-None (spec Gap 2): None's
  // components→communities hierarchy can have huge flat communities + many orphan/isolated
  // nodes, so without normalization its bootstrap antichain starts over budget and can never
  // become feasible. The deterministic balanced-chunk fallback (no edges/paths supplied)
  // guarantees the invariants for None; the smarter strategies are wired in P1.
  const hierarchy = buildRepresentationHierarchy(input.snapshot, input.nodeIds, {
    nodeCost,
    visibleNode: input.visibleNode,
    bootstrapRoots: true,
    intermediateTiers: true,
  });
  // STABLE proxy geometry (design Gap 3 / P2). Computed ONCE here from the hierarchy structure —
  // engine-independent — and kept as the cut's fallback bounds for every recut. This also seeds
  // the hierarchy's `bounds*` columns; a recut overwrites them per-rep from the live scene boxes
  // when the engine produces them, but reuses the stable box for any rep the engine left out.
  const stableBounds = computeStableProxyBounds(hierarchy);
  const repOfGroupId = new Map<GroupId, number>();
  for (let g = 0; g < input.snapshot.groupIds.length; g++) {
    repOfGroupId.set(input.snapshot.groupIds[g], hierarchy.repOfGroup[g]);
  }
  // Build the persistent CSR edge index ALONGSIDE the hierarchy (design B2 + impl note (a)),
  // from the post-filter edges — cached on this same material signature, reused across recuts.
  // Hidden endpoints are dropped by the index itself (a leaf rep under DETACHED_REP).
  const edgeIndex = input.edges ? buildRepresentationEdgeIndex(hierarchy, input.edges) : undefined;
  // The eviction controller's key space is the rep count; rebuild it when the rep count
  // changes (a new hierarchy), else reuse the prior controller (its tracking is stale only
  // when the rep id domain moved, which a material change implies — so a fresh one is correct).
  const eviction = makeEvictionController(hierarchy.repCount, offscreenOpenBudget);
  return {
    signature,
    hierarchy,
    stableBounds,
    edgeIndex,
    nodeIds: input.nodeIds,
    repOfGroupId,
    eviction,
    lodRuntime: undefined,
  };
}

/** Default offscreen auto-open budget for a runtime's eviction controller (mirrors the canvas). */
const DEFAULT_OFFSCREEN_OPEN_BUDGET = 64;

export interface RepLodResult {
  hierarchy: RepresentationHierarchy;
  cut: LodCut;
  runtime: LodRuntimeState;
  /**
   * The persistent runtime this solve used (Gap 4). Hand it back to
   * {@link acquireRepresentationRuntime} on the next recut: when the material signature is
   * unchanged the SAME hierarchy/ordinals/group-id map are reused (no O(N) rebuild). Present
   * whenever the solve ran against a runtime (always, since the entry point acquires one).
   */
  repRuntime: RepresentationRuntime;
  /** True iff this solve materially changed the committed cut (a generation fired). */
  committed: boolean;
  /** The box keys of selected proxy reps — the collapsed set the render path consumes. */
  collapsedBoxKeys: Set<string>;
  /** The OPEN namespaced group ids (groupLodSelection over collapsedBoxKeys). */
  openSelection: Set<GroupId>;
  /** O(1) membership over the cut (for representativeOf / highlight). */
  runtimeCut: RuntimeLodCut;
  /** The budget used for the solve (for the overlay's vs-budget readouts). */
  budget: LodBudget;
  /** Wall-clock of the solve (ms). */
  cutSolveMs: number;
  /** The solver's diagnostics when requested (why-not-refined + refinements), else null. */
  diagnostics: SolveDiagnostics | null;
  /**
   * Explicit opens that hit a FINITE hard ceiling and were retained at the nearest proxy
   * ("Detail limited" — design "Finite budget model"). Always populated (independent of
   * `collectDiagnostics`); empty when every forced open was honored within hard. The UI
   * surfaces an honest message naming each `limitingBudget` rather than silently expanding.
   */
  limitedDetails: LimitedDetail[];
  /** Auto-opens evicted THIS solve (offscreen-over-budget); 0 without an eviction controller. */
  evictions: number;
  /** Cumulative evictions since the controller was created; 0 without one. */
  totalEvictions: number;
}

/**
 * Build the representation cut for the current camera and derive the collapse-shaped
 * selection the existing render path consumes. Pure; the heavy downstream work runs only
 * when `committed` is true (the caller gates the scene rebuild on it).
 */
export function buildSceneRepresentationCut(input: RepLodInput): RepLodResult {
  const { snapshot, boxes, cam, vp, intent, options } = input;

  // 0. Acquire the PERSISTENT runtime (Gap 4). When the caller passes a runtime whose
  //    material signature already matches the input, the cached hierarchy / node ordinals /
  //    group-id map are REUSED — a camera recut never rebuilds them. Otherwise (no runtime
  //    passed, or a stale one) a fresh runtime is constructed once here. The hierarchy,
  //    repOfGroupId and eviction controller all come FROM the runtime from this point on.
  const runtime = acquireRepresentationRuntime(input, input.runtime);
  const hierarchy = runtime.hierarchy;
  const cols = hierarchy.columns;
  const repOfGroupId = runtime.repOfGroupId;
  const stableBounds = runtime.stableBounds;

  // A group rep detached by the post-filter mask (no visible members) is skipped throughout:
  // it gets no bounds, no intent constraint, and no place in the cut.
  const isDetachedGroup = (rep: number): boolean =>
    cols.parentByRep[rep] === DETACHED_REP && cols.firstChildByRep[rep] === -1;

  // 2. UPDATE proxy bounds for every rep — the per-recut camera update, mutating the cached
  //    hierarchy's geometry columns IN PLACE (never reconstructing them). Each rep takes the
  //    visual engine's LIVE box for its group when one exists; otherwise it falls back to the
  //    STABLE, layout-independent box (design Gap 3 / P2). The stable fallback is the fix for
  //    "not actually layout-independent": under Grid / the classic engines / None the engine
  //    emits NO cluster boxes, so without this every rep would read as height-0 / off-screen and
  //    the cut would be inert. Now every non-detached rep ALWAYS has bounds, so the cut OPERATES
  //    with every engine, not merely ignores its name. Seed ALL reps from the stable bounds first
  //    (group reps, leaf reps, and render-only intermediate / bootstrap proxies — none of which
  //    the engine addresses by group box key), then override the group reps the engine DID place.
  for (let rep = 0; rep < hierarchy.repCount; rep++) {
    cols.boundsX[rep] = stableBounds.x[rep];
    cols.boundsY[rep] = stableBounds.y[rep];
    cols.boundsW[rep] = stableBounds.w[rep];
    cols.boundsH[rep] = stableBounds.h[rep];
  }
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    const rep = hierarchy.repOfGroup[g];
    if (isDetachedGroup(rep)) continue; // fully filtered out — no proxy to place
    const box = boxes.get(snapshot.boxKeyByGroup[g]);
    if (!box) continue; // engine emitted no box for this group → keep the stable fallback box
    cols.boundsX[rep] = box.x;
    cols.boundsY[rep] = box.y;
    cols.boundsW[rep] = box.w;
    cols.boundsH[rep] = box.h;
  }

  // 3a. Intent → constraints (rep ids from the cached group-id map). A group id with no rep
  //     (stale id from another mode) is ignored.
  const forceClosed = new Set<number>();
  const forceOpen = new Set<number>();
  for (const [gid, state] of intent) {
    const rep = repOfGroupId.get(gid);
    if (rep === undefined) continue;
    if (isDetachedGroup(rep)) continue; // intent on a fully filtered-out group is inert
    if (state === "closed") forceClosed.add(rep);
    else if (state === "open") forceOpen.add(rep);
  }
  const constraints: CutConstraints = { forceClosed, forceOpen };

  // The EFFECTIVE box of a group rep: the visual engine's live box when it placed one, else the
  // STABLE layout-independent box (design Gap 3 / P2). Under Grid / the classic engines / None the
  // engine emits no cluster box, so the live lookup misses — but the rep still has stable geometry,
  // so the gate below OPERATES under every engine instead of short-circuiting to "can't refine".
  const effectiveGroupBox = (g: number): Box | undefined => {
    const live = boxes.get(snapshot.boxKeyByGroup[g]);
    if (live) return live;
    const rep = hierarchy.repOfGroup[g];
    const w = stableBounds.w[rep];
    const h = stableBounds.h[rep];
    if (w <= 0 || h <= 0) return undefined; // detached / empty — genuinely no geometry
    return { x: stableBounds.x[rep], y: stableBounds.y[rep], w, h };
  };

  // 3b. Refine gate: a proxy auto-refines only when its box is on-screen AND at least
  //     openPx tall (legible). The box is the engine's live box OR the stable fallback, so a
  //     proxy can refine under EVERY engine (not only the cluster-box-emitting ones — that
  //     short-circuit was Gap 3's inertness). Forced opens ignore this gate (handled in the solver).
  const canRefine = (rep: number): boolean => {
    const g = cols.groupByRep[rep];
    if (g === NO_GROUP) {
      // A render-only intermediate / bootstrap proxy (no group) still refines when it has stable
      // geometry on-screen and legible — otherwise an oversized group could never open under a
      // box-less engine. Leaf reps (no children) never reach the solver's refine path.
      if (cols.firstChildByRep[rep] === -1) return false;
      const w = stableBounds.w[rep];
      const h = stableBounds.h[rep];
      if (w <= 0 || h <= 0) return false;
      const box: Box = { x: stableBounds.x[rep], y: stableBounds.y[rep], w, h };
      if (!intersectsViewport(worldToScreen(box, cam), vp, options.margin)) return false;
      return screenHeight(box, cam.scale) >= options.openPx;
    }
    const box = effectiveGroupBox(g);
    if (!box) return false;
    if (!intersectsViewport(worldToScreen(box, cam), vp, options.margin)) return false;
    return screenHeight(box, cam.scale) >= options.openPx;
  };

  // 4. Budget — the FINITE split model (design "Finite budget model"; Gap 6). Soft targets
  //    steer AUTO refinement; FINITE hard ceilings cap forced opens. Every ceiling is finite
  //    by construction — a forced open is capped at `hardCards`/`hardLayoutCost`, NOT expanded
  //    to the whole graph. Cards (visible antichain width) and layout cost (Σ 1 + symbols) are
  //    DISTINCT dimensions. Card budgets derive from the caller's options; the remaining
  //    finite ceilings come from the shared production defaults (LOD_BUDGET).
  //
  //    When intent can't be honored within the hard ceiling the solver retains the nearest
  //    proxy and surfaces "Detail limited" (LimitedDetail) rather than silently expanding.
  const targetCards = Math.min(options.maxCards, options.nodeBudget);
  const hardCards = options.nodeBudget;
  const budget: LodBudget = {
    targetCards,
    hardCards: Math.max(hardCards, targetCards),
    targetLayoutCost: LOD_BUDGET.targetLayoutCost,
    hardLayoutCost: LOD_BUDGET.hardLayoutCost,
    targetEdges: LOD_BUDGET.targetEdges,
    hardEdges: LOD_BUDGET.hardEdges,
    targetLabels: LOD_BUDGET.targetLabels,
    hardLabels: LOD_BUDGET.hardLabels,
    maxGpuBytes: LOD_BUDGET.maxGpuBytes,
  };

  const camState: CameraState = { x: cam.x, y: cam.y, scale: cam.scale, viewport: vp };
  const diagnostics: SolveDiagnostics | null = input.collectDiagnostics
    ? { whyNotRefined: new Map(), refinements: 0, limited: [] }
    : null;
  // "Detail limited" is surfaced ALWAYS (not gated on collectDiagnostics): when no full
  // diagnostics sink is requested, a minimal sink still captures the forced-open limits.
  const limitSink: SolveDiagnostics = diagnostics ?? {
    whyNotRefined: new Map(),
    refinements: 0,
    limited: [],
  };
  // The persistent cut-aware edge index (design B2) drives the solver's marginal edge gate:
  // a refine is priced by its ACTUAL quotient-graph Δedges, not the inert additive per-rep
  // edgeCost. Present only when the caller supplied `edges` (the index is built on the runtime).
  const edgeIndex = runtime.edgeIndex;
  const t0 = nowMs();
  let cut = solveLodCut(hierarchy, bootstrapCut(hierarchy), constraints, camState, budget, {
    canRefine,
    diagnostics: limitSink,
    edgeIndex,
  });

  // 4b. Deadband retention + bounded offscreen-auto-open eviction (Phase C1c bug b). The
  //     first solve above only opens proxies whose box is on-screen (the canRefine gate), so
  //     a group re-collapses the instant it leaves the viewport — there's no deadband, and
  //     nothing to evict. With an eviction controller, we RETAIN previously-auto-opened
  //     groups across recuts (they stay open through a small pan/zoom-out — the spec's
  //     deadband), and the IntrusiveLru BOUNDS how many such retained opens persist: when the
  //     tracked set exceeds the offscreen-open budget, the oldest are evicted (re-collapsed).
  //     A second solve folds the retention into forceOpen and the evictions into forceClosed.
  //     Forced (user-intent) opens/closes are untouched — eviction never fights user intent.
  // The eviction controller is the ACQUIRED runtime's own (Gap 4) when the caller opted into
  // the persistent runtime — read from `runtime`, NOT `input.runtime`: when the passed runtime
  // was stale (signature mismatch) `acquire` rebuilt it with a controller sized to the NEW rep
  // count, and the old controller's key space would be wrong. A legacy per-call `input.eviction`
  // override still wins for callers that haven't adopted the persistent runtime. When the caller
  // passes neither `runtime` nor `eviction`, the legacy no-eviction path runs (a fresh runtime
  // cut, evictions = 0) — so guard on `input.runtime` having been supplied.
  const eviction = input.eviction ?? (input.runtime ? runtime.eviction : undefined);
  let evictions = 0;
  let totalEvictions = 0;
  if (eviction) {
    const onScreen = (rep: number): boolean => {
      const g = cols.groupByRep[rep];
      if (g === NO_GROUP) return false;
      // Live box when the engine placed one, else the stable fallback (design Gap 3 / P2) — so a
      // box-less engine (Grid / classic / None) still tracks visibility for the eviction LRU.
      const box = effectiveGroupBox(g);
      if (!box) return false;
      return intersectsViewport(worldToScreen(box, cam), vp, options.margin);
    };
    // Candidate open set = groups freshly auto-opened on-screen this frame ∪ those retained
    // from prior frames (the deadband). User-forced opens are excluded (tracked separately).
    const freshOpens = autoOpenGroupReps(hierarchy, cut, forceOpen);
    const candidates = new Set<number>(eviction.retained());
    for (const rep of freshOpens) candidates.add(rep);
    for (const rep of forceOpen) candidates.delete(rep);

    const outcome = eviction.recordOpen(candidates, onScreen);
    evictions = outcome.count;
    totalEvictions = eviction.totalEvictions;

    // Retained-open after eviction → forceOpen (stay open even offscreen); evicted → closed.
    const retainOpen = new Set<number>(candidates);
    for (const rep of outcome.evicted) retainOpen.delete(rep);

    if (retainOpen.size > 0 || outcome.evicted.size > 0) {
      const nextOpen = new Set<number>(forceOpen);
      for (const rep of retainOpen) nextOpen.add(rep);
      const nextClosed = new Set<number>(forceClosed);
      for (const rep of outcome.evicted) nextClosed.add(rep);
      // Re-solve from a clean limit sink so limitedDetails reflects only the FINAL cut.
      limitSink.limited.length = 0;
      cut = solveLodCut(
        hierarchy,
        bootstrapCut(hierarchy),
        { forceClosed: nextClosed, forceOpen: nextOpen },
        camState,
        budget,
        { canRefine, diagnostics: limitSink, edgeIndex },
      );
    }
  }
  const cutSolveMs = nowMs() - t0;

  // 5. Commit through the committed-generation runtime (only a material change bumps the
  //    generation). When the caller adopted the persistent runtime, ITS own `lodRuntime`
  //    (Gap 4) is authoritative — carried across recuts, and `undefined` after a rebuild so a
  //    material change starts a fresh chain (committed=true). A legacy `previous` override is
  //    used ONLY when no runtime was supplied, so it can never hijack a live runtime's chain.
  //    The committed result is written back onto the persistent runtime so the NEXT recut
  //    continues the same generation chain without rebuilding anything.
  const filterSignature = input.filterSignature ?? "";
  const sig = cutSignature(cut, 0, 0, filterSignature);
  let lodRuntime = input.runtime ? runtime.lodRuntime : input.previous;
  let committed: boolean;
  if (!lodRuntime) {
    lodRuntime = createLodRuntime(cut, sig);
    committed = true; // the first cut is the initial committed generation
  } else {
    setPending(lodRuntime, cut, sig);
    committed = commitIfMaterial(lodRuntime);
  }
  runtime.lodRuntime = lodRuntime;

  // Derive the collapsed box-key set from the SELECTED proxy reps. (Use the committed cut
  // so the derived scene matches what the renderer will draw.)
  const effective = lodRuntime.committedCut;
  const collapsedBoxKeys = collapsedBoxKeysOf(hierarchy, effective);
  const openSelection = openSelectionOf(hierarchy, effective);
  // Roll the runtime cut IN PLACE via the controller (reuses the epoch array when the rep
  // count is unchanged — no fresh Uint32Array per recut); else a one-off fresh cut.
  const runtimeCut = eviction
    ? eviction.advanceCut(effective, hierarchy.repCount)
    : makeRuntimeCut(effective, hierarchy.repCount);

  return {
    hierarchy,
    cut: effective,
    runtime: lodRuntime,
    repRuntime: runtime,
    committed,
    collapsedBoxKeys,
    openSelection,
    runtimeCut,
    budget,
    cutSolveMs,
    diagnostics,
    limitedDetails: limitSink.limited,
    evictions,
    totalEvictions,
  };
}

/** Monotonic clock in ms (performance.now when available, else Date.now). */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * The active proxy's box key for an underlying node, or null when the node's OWN leaf rep
 * is selected (it's drawn as itself, no proxy stands in). The selected-hidden-node →
 * highlight-its-proxy mapping (spec). Walks the leaf's ancestors to the selected rep.
 */
export function activeProxyBoxKeyOfNode(result: RepLodResult, nodeOrdinal: number): string | null {
  const { hierarchy, runtimeCut } = result;
  const rep = representativeOf(hierarchy, nodeOrdinal, runtimeCut.isSelected);
  if (rep === -1) return null;
  // A leaf rep represents the node itself → no proxy.
  if (hierarchy.columns.firstChildByRep[rep] === -1) return null;
  const g = hierarchy.columns.groupByRep[rep];
  if (g === NO_GROUP) return null;
  return hierarchy.snapshot.boxKeyByGroup[g];
}

// ── derivations ──────────────────────────────────────────────────────────────

/**
 * The AUTO-opened group reps in a cut (Phase C1c bug b eviction input): group reps that are
 * OPEN (no selected ancestor-or-self group rep on their chain), have children (a real
 * proxy), and are NOT user-forced-open (so eviction never fights a user expansion). These
 * are the proxies the camera opened; the controller bounds how many offscreen ones persist.
 */
function autoOpenGroupReps(
  h: RepresentationHierarchy,
  cut: LodCut,
  forceOpen: ReadonlySet<number>,
): number[] {
  const selected = new Set(cut.selectedRepresentations);
  const groupCount = h.snapshot.groupIds.length;
  const out: number[] = [];
  for (let g = 0; g < groupCount; g++) {
    if (h.columns.firstChildByRep[g] === -1) continue; // no children → nothing to re-collapse
    if (forceOpen.has(g)) continue; // user-forced open — never evicted
    // Open iff no selected group rep on the chain from g up to the root.
    let cur = g;
    let open = true;
    let guard = h.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) {
        open = false;
        break;
      }
      cur = h.columns.parentByRep[cur];
    }
    if (open) out.push(g);
  }
  return out;
}

/** The box keys of every SELECTED GROUP rep (proxies the scene collapses). */
function collapsedBoxKeysOf(h: RepresentationHierarchy, cut: LodCut): Set<string> {
  const out = new Set<string>();
  const groupCount = h.snapshot.groupIds.length;
  for (const rep of cut.selectedRepresentations) {
    // Only group reps (id < groupCount) collapse a group; selected leaf reps are open nodes.
    if (rep < groupCount) out.add(h.snapshot.boxKeyByGroup[h.columns.groupByRep[rep]]);
  }
  return out;
}

/**
 * The OPEN namespaced group ids: a group is open iff neither its rep nor any ancestor
 * group's rep is selected. Identical semantics to group-cut's groupLodSelection, computed
 * here directly from the rep tree (so a caller need not re-derive it).
 */
function openSelectionOf(h: RepresentationHierarchy, cut: LodCut): Set<GroupId> {
  const selected = new Set(cut.selectedRepresentations);
  const groupCount = h.snapshot.groupIds.length;
  const out = new Set<GroupId>();
  for (let g = 0; g < groupCount; g++) {
    const rep = h.repOfGroup[g];
    // A DETACHED group (fully hidden under the post-filter mask — parent -2, no children)
    // has no visible members: it is neither open nor part of the rendered selection. Skip
    // it so a filtered-out group never leaks into the open set (Gap 7).
    if (h.columns.parentByRep[rep] === DETACHED_REP && h.columns.firstChildByRep[rep] === -1) {
      continue;
    }
    // Walk up the GROUP rep chain; open iff no selected group rep on the path.
    let cur = rep;
    let collapsed = false;
    let guard = h.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) {
        collapsed = true;
        break;
      }
      cur = h.columns.parentByRep[cur];
    }
    if (!collapsed) out.add(h.snapshot.groupIds[g]);
  }
  return out;
}
