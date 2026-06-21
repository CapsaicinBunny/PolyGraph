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
  buildRepresentationHierarchy,
  type RepresentationHierarchy,
  representativeOf,
} from "./representation";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  cutSignature,
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
import type { CollapseIntent, GroupId } from "./collapse-model";

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
  /** Collect the solver's why-not-refined diagnostics (Appendix A §I observability). */
  collectDiagnostics?: boolean;
}

export interface RepLodResult {
  hierarchy: RepresentationHierarchy;
  cut: LodCut;
  runtime: LodRuntimeState;
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
}

/**
 * Build the representation cut for the current camera and derive the collapse-shaped
 * selection the existing render path consumes. Pure; the heavy downstream work runs only
 * when `committed` is true (the caller gates the scene rebuild on it).
 */
export function buildSceneRepresentationCut(input: RepLodInput): RepLodResult {
  const { snapshot, nodeIds, boxes, cam, vp, intent, options } = input;
  const nodeCost = options.nodeCost ?? (() => 1);

  // 1. Hierarchy with rendered + subtree costs.
  const hierarchy = buildRepresentationHierarchy(snapshot, nodeIds, { nodeCost });
  const cols = hierarchy.columns;

  // 2. Populate proxy bounds from live scene boxes (group reps only; leaf reps keep 0).
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    const rep = hierarchy.repOfGroup[g];
    const box = boxes.get(snapshot.boxKeyByGroup[g]);
    if (!box) continue;
    cols.boundsX[rep] = box.x;
    cols.boundsY[rep] = box.y;
    cols.boundsW[rep] = box.w;
    cols.boundsH[rep] = box.h;
  }

  // 3a. Intent → constraints. A group id with no rep (stale id from another mode) is
  //     ignored. forceClosed/forceOpen are rep ids.
  const repOfGroupId = new Map<GroupId, number>();
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    repOfGroupId.set(snapshot.groupIds[g], hierarchy.repOfGroup[g]);
  }
  const forceClosed = new Set<number>();
  const forceOpen = new Set<number>();
  for (const [gid, state] of intent) {
    const rep = repOfGroupId.get(gid);
    if (rep === undefined) continue;
    if (state === "closed") forceClosed.add(rep);
    else if (state === "open") forceOpen.add(rep);
  }
  const constraints: CutConstraints = { forceClosed, forceOpen };

  // 3b. Refine gate: a proxy auto-refines only when its box is on-screen AND at least
  //     openPx tall (legible). A proxy with NO live box stays coarse (the safe default,
  //     matching computeGroupCut). Forced opens ignore this gate (handled in the solver).
  const canRefine = (rep: number): boolean => {
    const g = cols.groupByRep[rep];
    if (g === NO_GROUP) return false; // orphan leaf — nothing to refine anyway
    const box = boxes.get(snapshot.boxKeyByGroup[g]);
    if (!box) return false;
    if (!intersectsViewport(worldToScreen(box, cam), vp, options.margin)) return false;
    return screenHeight(box, cam.scale) >= options.openPx;
  };

  // 4. Budget. Soft target bounds AUTO refinement (cards); the hard ceiling lets a forced
  //    open exceed soft up to the whole graph's size (so user intent is never stuck).
  const totalNodes = sumLeafNodeCost(hierarchy);
  const budget: LodBudget = {
    targetNodes: Math.min(options.maxCards, options.nodeBudget),
    targetEdges: Infinity,
    targetLabels: Infinity,
    hardNodes: Math.max(options.nodeBudget, totalNodes),
    hardEdges: Infinity,
    hardLabels: Infinity,
    maxGpuBytes: Infinity,
    maxLayoutWork: Math.max(options.nodeBudget, totalNodes),
  };

  const camState: CameraState = { x: cam.x, y: cam.y, scale: cam.scale, viewport: vp };
  const diagnostics: SolveDiagnostics | null = input.collectDiagnostics
    ? { whyNotRefined: new Map(), refinements: 0 }
    : null;
  const t0 = nowMs();
  const cut = solveLodCut(hierarchy, bootstrapCut(hierarchy), constraints, camState, budget, {
    canRefine,
    diagnostics: diagnostics ?? undefined,
  });
  const cutSolveMs = nowMs() - t0;

  // 5. Commit through the runtime (only a material change bumps the generation).
  const filterSignature = input.filterSignature ?? "";
  const sig = cutSignature(cut, 0, 0, filterSignature);
  let runtime = input.previous;
  let committed: boolean;
  if (!runtime) {
    runtime = createLodRuntime(cut, sig);
    committed = true; // the first cut is the initial committed generation
  } else {
    setPending(runtime, cut, sig);
    committed = commitIfMaterial(runtime);
  }

  // Derive the collapsed box-key set from the SELECTED proxy reps. (Use the committed cut
  // so the derived scene matches what the renderer will draw.)
  const effective = runtime.committedCut;
  const collapsedBoxKeys = collapsedBoxKeysOf(hierarchy, effective);
  const openSelection = openSelectionOf(hierarchy, effective);
  const runtimeCut = makeRuntimeCut(effective, hierarchy.repCount);

  return {
    hierarchy,
    cut: effective,
    runtime,
    committed,
    collapsedBoxKeys,
    openSelection,
    runtimeCut,
    budget,
    cutSolveMs,
    diagnostics,
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
    // Walk up the GROUP rep chain; open iff no selected group rep on the path.
    let cur = rep;
    let collapsed = false;
    let guard = h.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
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

/** Total leaf (underlying-node) cost — the full-open size, for the hard ceiling. */
function sumLeafNodeCost(h: RepresentationHierarchy): number {
  let total = 0;
  for (const rep of h.columns.leafRepresentationByNode) total += h.columns.nodeCost[rep];
  return total;
}
