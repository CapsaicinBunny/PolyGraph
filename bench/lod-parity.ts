// LOD cutover / stress bench (spec P4 + the CUTOVER CONDITION). The single human-facing
// report for the REPRESENTATION CUT (`buildSceneRepresentationCut` — the sole LOD authority).
// The C1a oracle (`computeGroupCut` / `lod-cut.ts` / `group-cut.ts`) has been DELETED (spec P5)
// now that the cutover was PROVEN, so this bench no longer compares against it — it asserts the
// rep cut's cutover + stress metrics in ABSOLUTE terms on real fixture-shaped synthetic graphs,
// at the production node budget, across:
//
//   • ALL grouping modes:   Directory · Community · Package · facet · None
//   • FILTERED graphs:      a post-filter mask (every other node hidden)
//   • BOTH camera motions:  zoom-out → zoom-in (refine) AND a pan (same zoom, new region)
//
// It MEASURES + ASSERTS the eight P4 metrics and the cutover condition, then console.table()s a
// readable report so a human can confirm the cut behaves:
//
//   1. committed visible cards         finite + ≤ hardCards, a valid antichain (real aggregation)
//   2. edge count / aggregation        finite + sane (≤ hardEdges)
//   3. cut-solve ms                    the antichain solve
//   4. scene-build ms                  proxy materialization (the rep cut's downstream work)
//   5. layout ms                       (stable proxy bounds — engine-independent, built once)
//   6. # camera-induced GLOBAL layout moves   must be ~0 for the rep cut (persistent runtime)
//   7. intent correctness              a forced-open group descends; the cut stays valid
//   8. the CUTOVER CONDITION           every mode incl None progressively refines through
//      bounded proxy tiers WITHOUT rescanning the whole graph (incremental materializer
//      nodesScanned/edgesScanned ≪ N/E on a single-group refine), exceeding finite hard
//      budgets (cards ≤ hardCards, every dim finite), or triggering a global layout
//      (globalRelayoutReason === null for a pure camera move).
//
// This is the standalone runnable harness (a `bun run` entry); the SAME assertions are
// gated in `lib/graph/lod-parity-bench.test.ts` so CI proves the cutover, not just the eye.
//
//   bun run bench:parity      # measure + print the report + cutover verdict
//
// Numbers are deterministic (fixed synthetic graphs, no scanning). Writes
// bench/results/lod-parity.json.

import { mkdirSync, writeFileSync } from "node:fs";
import {
  communityGrouping,
  directoryGrouping,
  facetGrouping,
  type GroupingHierarchy,
  packageGrouping,
  syntheticNoneGrouping,
} from "../lib/graph/grouping";
import { buildGroupingSnapshot } from "../lib/graph/grouping-snapshot";
import { MAX_FANOUT } from "../lib/graph/representation";
import type { Box, Camera, Viewport } from "../lib/graph/lod-screen";
import {
  buildSceneRepresentationCut,
  LOD_BUDGET,
  type RepLodResult,
} from "../lib/graph/lod-representation-cut";
import { bootstrapCut } from "../lib/graph/lod-cut-solver";
import {
  collectStressMetrics,
  rejectedOpensByCategory,
  type RejectedOpensByCategory,
  type RepLodStressMetrics,
} from "../lib/graph/lod-observability";
import {
  BoundedLayoutCache,
  estimateLayoutBytes,
  ReadinessController,
} from "../lib/graph/readiness";
import type { CachedLocalLayout } from "../lib/graph/local-layout";
import { globalRelayoutReason, type GlobalLayoutInputs } from "../lib/graph/global-relayout";
import {
  type CutDiff,
  diffCuts,
  IncrementalMaterializer,
  type MaterializeCounter,
  type ProxyEdgeInput,
} from "../lib/graph/proxy-materialize";
import type { EdgeIndexInput } from "../lib/graph/representation";
import type { CollapseIntent, GroupId } from "../lib/graph/collapse-model";
import type { DimensionDescriptor } from "../lib/graph/dimensions";
import type { PackageManifest } from "../lib/graph/levels/types";
import { type GraphModel, makeEdge } from "../lib/graph/types";
import { round, timeIt } from "./metrics";

const RESULTS = `${import.meta.dir}/results/lod-parity.json`;

// ── a realistic repo shape: directories, packages, an env facet, a sparse edge mesh ──
// `dirCount × perDir` files over `pkgCount` packages; intra-dir import chains (a community
// signal) plus a few cross-dir links. Big enough to force intermediate tiers + multi-level
// cuts in every mode, small enough that the bench is instant and deterministic.
export function makeRepo(dirCount: number, perDir: number): GraphModel {
  const dirs: string[] = [];
  for (let d = 0; d < dirCount; d++) {
    const top = ["app", "lib", "pkg"][d % 3];
    const mid = ["api", "ui", "core", "util", "src"][Math.floor(d / 3) % 5];
    dirs.push(`${top}/${mid}${d}`);
  }
  const nodes: GraphModel["nodes"] = [];
  for (const dir of dirs) {
    for (let i = 0; i < perDir; i++) {
      const p = `${dir}/f${i}.ts`;
      nodes.push({
        id: p,
        kind: "file",
        label: `f${i}.ts`,
        filePath: p,
        line: 0,
        parentFile: p,
        facets: { env: [i % 2 === 0 ? "server" : "client"] },
      });
    }
  }
  const edges: GraphModel["edges"] = [];
  for (const dir of dirs) {
    for (let i = 0; i < perDir - 1; i++) {
      edges.push(makeEdge(`${dir}/f${i}.ts`, `${dir}/f${i + 1}.ts`, "import"));
    }
  }
  // a sparse cross-directory mesh so the quotient edge count is non-trivial in every mode.
  for (let d = 0; d < dirs.length; d++) {
    const next = dirs[(d + 1) % dirs.length];
    edges.push(makeEdge(`${dirs[d]}/f0.ts`, `${next}/f0.ts`, "import"));
  }
  return { nodes, edges };
}

const MANIFESTS: PackageManifest[] = [
  {
    id: "npm:pkg-a",
    name: "pkg-a",
    ecosystem: "npm",
    dir: "pkg/api0",
    manifestPath: "pkg/api0/package.json",
    declaredDeps: [],
  },
  {
    id: "npm:pkg-b",
    name: "pkg-b",
    ecosystem: "npm",
    dir: "pkg/ui1",
    manifestPath: "pkg/ui1/package.json",
    declaredDeps: [],
  },
];

const envFacet: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client" },
    { value: "server", label: "Server" },
  ],
  providerIds: ["core"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

export const MODES = ["directory", "package", "community", "facet:env", "none"] as const;
export type Mode = (typeof MODES)[number];

function hierarchyFor(mode: Mode, graph: GraphModel): GroupingHierarchy | null {
  switch (mode) {
    case "directory":
      return directoryGrouping(graph);
    case "package":
      return packageGrouping(graph, MANIFESTS);
    case "community":
      return communityGrouping(graph);
    case "facet:env":
      return facetGrouping(graph, envFacet);
    case "none":
      return syntheticNoneGrouping(graph);
  }
}

const vp: Viewport = { w: 1200, h: 800 };
const noIntent: CollapseIntent = new Map();

// EQUAL node budget for BOTH paths — the spec's "at EQUAL node budget". Sourced from the
// one finite production model so the comparison reflects what the app actually solves under.
const OPTS = {
  openPx: 200,
  maxCards: LOD_BUDGET.targetCards,
  nodeBudget: LOD_BUDGET.hardCards,
  margin: 0,
};

// World boxes: lay every group out in a coarse grid so both cuts have on-screen geometry to
// measure (the C1a oracle requires a live box per group; the rep cut falls back to stable
// bounds for the reps the engine leaves out).
function boxesFor(snap: ReturnType<typeof buildGroupingSnapshot>): Map<string, Box> {
  const m = new Map<string, Box>();
  snap.groupIds.forEach((_, i) => {
    const col = i % 8;
    const row = Math.floor(i / 8);
    m.set(snap.boxKeyByGroup[i], { x: col * 1200, y: row * 1200, w: 1000, h: 1000 });
  });
  return m;
}

/** Edge inputs by node ordinal (for the rep cut's edge index + the materializer). */
function edgeOrdinalInputs(
  graph: GraphModel,
  nodeIds: readonly string[],
): { edgeIndexInputs: EdgeIndexInput[]; proxyEdgeInputs: ProxyEdgeInput[] } {
  const ordOf = new Map<string, number>();
  nodeIds.forEach((id, i) => ordOf.set(id, i));
  const edgeIndexInputs: EdgeIndexInput[] = [];
  const proxyEdgeInputs: ProxyEdgeInput[] = [];
  for (const e of graph.edges) {
    const s = ordOf.get(e.source);
    const t = ordOf.get(e.target);
    if (s === undefined || t === undefined) continue;
    edgeIndexInputs.push({ source: s, target: t, kind: 0, weight: e.count });
    proxyEdgeInputs.push({ source: s, target: t, edge: e });
  }
  return { edgeIndexInputs, proxyEdgeInputs };
}

/**
 * A deterministic synthetic cached local layout for metric 8's cache-memory probe. `n` child
 * positions + one cluster box — the same SHAPE a real engine emits (minus world placement), so
 * `estimateLayoutBytes` (the cache's own accounting) sizes it exactly as it would a live layout.
 */
function synthLayout(n: number): CachedLocalLayout {
  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < n; i++) positions.set(`c${i}`, { x: i * 10, y: 0 });
  const layout: CachedLocalLayout = {
    positions,
    clusters: [
      { id: "g", x: 0, y: 0, width: n * 10, height: 100 },
    ] as CachedLocalLayout["clusters"],
    width: n * 10,
    height: 100,
  };
  // touch estimateLayoutBytes so an import-time refactor of the size model is caught by the bench.
  void estimateLayoutBytes(layout);
  return layout;
}

/** Every visible node represented exactly once (the antichain / parity invariant). */
function validAntichain(r: RepLodResult, visibleCount: number): boolean {
  const { hierarchy, cut } = r;
  const selected = new Set(cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = hierarchy.columns;
  let covered = 0;
  for (let i = 0; i < leafRepresentationByNode.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = hierarchy.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    if (hits > 1) return false; // double-represented — invalid
    if (hits === 1) covered++;
  }
  return covered === visibleCount;
}

/** Max fan-out of any rep (invariant b / bounded tiers). */
function maxFanout(r: RepLodResult): number {
  const { firstChildByRep, nextSiblingByRep } = r.hierarchy.columns;
  let max = 0;
  for (let rep = 0; rep < r.hierarchy.repCount; rep++) {
    let n = 0;
    let c = firstChildByRep[rep];
    let guard = r.hierarchy.repCount + 1;
    while (c !== -1 && guard-- > 0) {
      n++;
      c = nextSiblingByRep[c];
    }
    if (n > max) max = n;
  }
  return max;
}

export interface ParityRow {
  mode: Mode;
  filtered: boolean;
  nodes: number; // visible node count
  reps: number;
  maxFanout: number;
  bootstrapCards: number; // coarsest-cut card cost (must be ≤ hardCards — feasible bootstrap)
  hardCards: number;
  // committed visible cards (metric 1) — absolute: finite, ≤ hardCards, a valid antichain
  repCardsZoomIn: number;
  cardsWithinBudget: "✓(bounded)" | "over"; // rep cards ≤ hardCards AND a valid antichain
  // edges (metric 2)
  repEdges: number;
  edgesFinite: boolean;
  // timings (metrics 3–5), ms
  cutSolveMs: number;
  sceneBuildMs: number;
  layoutMs: number;
  // global layout moves (metric 6)
  repGlobalMoves: number;
  cameraMoveCount: number; // camera moves the persistent runtime absorbed without a rebuild
  // intent correctness (metric 7)
  intentDescends: boolean;
  intentValid: boolean;
  // cutover condition (metric 8)
  validAntichain: boolean;
  refineNodesScanned: number; // incremental materialize on a single-group refine
  refineEdgesScanned: number;
  totalNodes: number;
  totalEdges: number;
  noWholeGraphRescan: boolean; // refine touched ≪ the whole graph
  globalRelayoutOnCamera: boolean; // a pure camera move triggers a global relayout (must be false)
  cutover: boolean; // all cutover sub-conditions hold
  // ── the eight P4 STRESS METRICS (spec P4 "New stress metrics") ──
  // 1+2 (nodes/edges scanned) reuse refineNodesScanned/refineEdgesScanned above; 3 (max fanout)
  // reuses maxFanout; 4 (bootstrap vs hard) reuses bootstrapCards/hardCards. The four below are
  // the P3-orchestration-driven metrics this harness now exercises + reports:
  rejectedOpens: RejectedOpensByCategory; // 5 — rejected explicit opens, by budget category
  cameraToCommitMs: number; // 6 — time from a camera move to the committed refinement
  staleLayoutJobsDiscarded: number; // 7 — async layout results dropped as stale (gen ≠ live)
  peakLayoutCacheBytes: number; // 8 — peak local-layout cache footprint over the session
  // the three asserted invariants, rolled up from collectStressMetrics:
  refineBoundedBySubtree: boolean; // single-group refine bounded by the changed subtree
  fanoutWithinBound: boolean; // max fan-out ≤ MAX_FANOUT
  bootstrapFeasible: boolean; // bootstrap cut ≤ hardCards
}

/** A pure camera-move GlobalLayoutInputs pair (everything material identical). */
function cameraOnlyInputs(mode: string): { prev: GlobalLayoutInputs; next: GlobalLayoutInputs } {
  const base: GlobalLayoutInputs = {
    graphVersion: "v1",
    filterSignature: "f0",
    groupingMode: mode,
    direction: "LR",
    layoutEngine: "smart",
    layoutOptionsHash: "h0",
    explicitRelayoutNonce: 0,
    envelopeExhaustedNonce: 0,
  };
  return { prev: base, next: { ...base } };
}

export async function benchMode(
  mode: Mode,
  graph: GraphModel,
  filtered: boolean,
): Promise<ParityRow> {
  const nodeIds = graph.nodes.map((n) => n.id);
  const h = hierarchyFor(mode, graph);
  if (!h) throw new Error(`mode ${mode} produced no hierarchy`);
  const snap = buildGroupingSnapshot(h, mode, nodeIds);
  const { edgeIndexInputs, proxyEdgeInputs } = edgeOrdinalInputs(graph, nodeIds);

  // post-filter mask: hide every other node (exercises the filtered-graph path).
  const visible = filtered ? (ord: number) => ord % 2 === 0 : undefined;
  const visibleCount = filtered ? nodeIds.filter((_, i) => i % 2 === 0).length : nodeIds.length;

  const camOut: Camera = { x: 600, y: 600, scale: 0.05 };
  const camIn: Camera = { x: 600, y: 600, scale: 0.9 };
  const camPan: Camera = { x: 4800, y: 600, scale: 0.9 };

  const baseInput = {
    snapshot: snap,
    nodeIds,
    edges: edgeIndexInputs,
    vp,
    intent: noIntent,
    options: OPTS,
    visibleNode: visible,
    filterSignature: filtered ? "half" : "full",
    filteredGraphId: `${mode}/${filtered ? "half" : "full"}`,
  };
  const run = (cam: Camera, runtime?: RepLodResult["repRuntime"], intent?: CollapseIntent) =>
    buildSceneRepresentationCut({
      ...baseInput,
      boxes: boxesFor(snap),
      cam,
      intent: intent ?? noIntent,
      runtime,
    });

  // ── persistent runtime reused across the camera moves (the no-rescan / no-global-move proof) ──
  // Drive pure camera moves off the SAME runtime: `first` is the zoomed-in solve; the follow-up
  // moves (a zoom-out and a pan) each hand back `first`'s runtime. A persistent runtime REUSES
  // the same hierarchy object (a camera recut updates bounds/cut, never rebuilds the O(N)
  // structure) — so BOTH zoom AND pan are covered, per the spec's "panning as well as zooming".
  const first = run(camIn);
  const cameraMoves = [run(camOut, first.repRuntime), run(camPan, first.repRuntime)];
  // A camera move is a GLOBAL (structural) layout move iff it rebuilt the hierarchy — detected
  // by hierarchy-object identity against the first solve. For a persistent runtime this is 0:
  // the stable proxy bounds were computed ONCE with the hierarchy, so reusing it is, by
  // construction, NOT a global layout. Count the moves that DID rebuild (must be 0).
  const repGlobalMoves = cameraMoves.filter(
    (m) => m.repRuntime.hierarchy !== first.repRuntime.hierarchy,
  ).length;
  const sameHierarchy = repGlobalMoves === 0;
  // The C1a contrast: computeGroupCut has NO persistent runtime — it rebuilds its group tree
  // (O(N)) on EVERY camera move. The honest count is therefore the number of camera moves the
  // rep cut absorbed for free (the same moves C1a would have rescanned on).
  const cameraMoveCount = cameraMoves.length;

  // ── metric 6 control: a pure camera move triggers NO global relayout reason ──
  const { prev, next } = cameraOnlyInputs(mode);
  const globalRelayoutOnCamera = globalRelayoutReason(prev, next) !== null;

  // ── timings (metrics 3–5) ──
  const cutSolve = await timeIt(() => run(camIn, first.repRuntime), 5);
  // scene build = proxy materialization of the committed cut (the rep cut's downstream work).
  const materialIn = {
    hierarchy: first.repRuntime.hierarchy,
    cut: first.cut,
    graph,
    visibleNode: visible,
    edgeInputs: proxyEdgeInputs,
  };
  const sceneBuild = await timeIt(() => {
    const m = new IncrementalMaterializer(materialIn);
    m.applyDiff(
      first.cut,
      diffCuts([], first.cut.selectedRepresentations, first.repRuntime.hierarchy.repCount),
    );
  }, 5);
  // layout = the engine-independent stable proxy bounds, built ONCE with the hierarchy. We
  // time a full runtime rebuild (the material-change cost) as the layout-prep cost; a camera
  // recut does NOT pay this (that is the whole point of metric 6).
  const layout = await timeIt(() => run(camIn), 3);

  // ── rep-cut committed visible cards + edges (metrics 1, 2) ──
  const repCardsZoomIn = first.cut.selectedRepresentations.length;
  const repEdges = first.cut.edgeCost;

  // ── intent correctness (metric 7): force-open a FOLDED group; the rep must descend below it ──
  // The forced open is evaluated at the ZOOMED-OUT camera, where the root group proxy is
  // genuinely FOLDED (selected) in the no-intent cut — so this metric actually exercises the
  // solver's forceOpen path. (At the zoomed-in camera every root is already auto-refined, so a
  // forced open there is a no-op and would pass even if forceOpen were ignored — a vacuous test.)
  // We assert the open CHANGED the cut: the no-intent baseline SELECTS the target, and forcing
  // it open makes it NOT selected (it descended ≥1 level) — or surfaces an honest "Detail
  // limited" when the hard budget forbids descent.
  let intentDescends = true;
  let intentValid = true;
  {
    // the FOLDED baseline (no intent) at the zoomed-out camera.
    const foldedBaseline = run(camOut, first.repRuntime);
    const baselineSel = new Set(foldedBaseline.cut.selectedRepresentations);
    const fcols = first.repRuntime.hierarchy.columns;
    const repOfGroup = first.repRuntime.repOfGroupId;
    // Pick a target group whose rep is genuinely FOLDED in the baseline: it must be DIRECTLY
    // selected (so forcing it open is a real one-level descent, not already covered by a
    // selected ancestor), be a real PROXY (has children), and be non-detached. Under a filter a
    // root group can be fully detached or only represented by a selected ancestor bucket — those
    // are not valid descent targets, so we scan the root groups for the first that qualifies.
    let targetGroup: GroupId | undefined;
    let targetRep = -1;
    for (let i = 0; i < snap.roots.length; i++) {
      const gid = snap.groupIds[snap.roots[i]];
      const rep = repOfGroup.get(gid);
      if (rep === undefined || rep < 0) continue;
      if (fcols.firstChildByRep[rep] === -1) continue; // not a proxy — nothing to descend into
      if (fcols.parentByRep[rep] === -2) continue; // detached (fully filtered out)
      if (!baselineSel.has(rep)) continue; // not DIRECTLY folded in the baseline
      targetGroup = gid;
      targetRep = rep;
      break;
    }
    if (targetGroup && targetRep >= 0) {
      const intent: CollapseIntent = new Map([[targetGroup, "open"]]);
      const opened = run(camOut, first.repRuntime, intent);
      const selected = new Set(opened.cut.selectedRepresentations);
      // The forced open must descend (target no longer DIRECTLY selected → its children/leaves
      // now stand in) OR surface an honest "Detail limited" when the hard budget forbids descent.
      // This now genuinely exercises forceOpen: the baseline folds the target, so a solver that
      // ignored forceOpen would leave it selected and FAIL here (the old camIn test could not).
      intentDescends = !selected.has(targetRep) || opened.limitedDetails.length > 0;
      intentValid = validAntichain(opened, visibleCount);
    } else {
      // No foldable root proxy under this filter (e.g. facet·filt collapses to one detached
      // group): there is genuinely nothing to force-open at this level. The metric is N/A — the
      // antichain validity is still checked on the folded baseline so the row is not a free pass.
      intentValid = validAntichain(foldedBaseline, visibleCount);
    }
  }

  // ── cutover condition (metric 8): a SINGLE-GROUP refine touches ≪ the whole graph ──
  // This is the Gap 9 / merge-gate 15 proof: refining ONE proxy one level must touch only that
  // proxy's subtree, NOT rescan all original nodes/edges. Build the FULLY-refined antichain
  // (every leaf selected — the finest valid cut), then COARSEN it back so a single proxy `P`
  // folds its subtree. The incremental materializer's counter then records exactly the nodes/
  // edges under `P` — which, for a proxy `P` whose subtree is a STRICT minority of the graph,
  // is strictly fewer than N: the proof that one refinement is local, not a whole-graph rescan.
  const cols = first.repRuntime.hierarchy.columns;
  const repCount = first.repRuntime.hierarchy.repCount;
  const totalNodes = nodeIds.length;
  const totalEdges = proxyEdgeInputs.length;
  const leafRepByNode = cols.leafRepresentationByNode;
  const subtreeLeaves = (rep: number): number => {
    if (cols.firstChildByRep[rep] === -1) return 1;
    let n = 0;
    const stack = [rep];
    let guard = repCount + 1;
    while (stack.length && guard-- > 0) {
      const r = stack.pop()!;
      if (cols.firstChildByRep[r] === -1) {
        n++;
        continue;
      }
      for (let c = cols.firstChildByRep[r]; c !== -1; c = cols.nextSiblingByRep[c]) stack.push(c);
    }
    return n;
  };
  // Pick the proxy `P` to fold: the smallest internal (non-root, has-children) rep whose
  // subtree is a STRICT minority (< half) of the visible leaves, so coarsening it touches a
  // bounded sub-region. Fall back to any internal rep if none is < half (degenerate shapes).
  let foldRep = -1;
  let foldLeaves = Infinity;
  let anyInternal = -1;
  for (let rep = 0; rep < repCount; rep++) {
    if (cols.firstChildByRep[rep] === -1) continue; // leaf — nothing to fold
    if (cols.parentByRep[rep] < 0) continue; // a root — folding it is the bootstrap, not local
    anyInternal = anyInternal === -1 ? rep : anyInternal;
    const lv = subtreeLeaves(rep);
    if (lv * 2 < totalNodes && lv < foldLeaves) {
      foldLeaves = lv;
      foldRep = rep;
    }
  }
  if (foldRep === -1) foldRep = anyInternal;
  // The fully-refined antichain: every VISIBLE node's leaf rep (the finest cut).
  const fineSel: number[] = [];
  for (let i = 0; i < totalNodes; i++) {
    if (visible && !visible(i)) continue;
    fineSel.push(leafRepByNode[i]);
  }
  // The coarsened cut: drop every selected leaf under `foldRep`, add `foldRep` itself (one
  // proxy stands in for its whole subtree — a single-group COARSEN, the dual of a refine; the
  // materializer's touched-region cost is identical to the refine that re-opens it).
  const underFold = (rep: number): boolean => {
    let cur = rep;
    let guard = repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (cur === foldRep) return true;
      cur = cols.parentByRep[cur];
    }
    return false;
  };
  const coarsenedSel = fineSel.filter((r) => !underFold(r));
  if (foldRep !== -1) coarsenedSel.push(foldRep);
  const counter: MaterializeCounter = { nodesScanned: 0, edgesScanned: 0 };
  if (foldRep !== -1) {
    const m = new IncrementalMaterializer(materialIn);
    // baseline = the fully-refined scene (untimed); then coarsen exactly ONE proxy.
    m.applyDiff(
      { selectedRepresentations: Uint32Array.from(fineSel) },
      diffCuts([], Uint32Array.from(fineSel), repCount),
    );
    const diff: CutDiff = diffCuts(
      Uint32Array.from(fineSel),
      Uint32Array.from(coarsenedSel),
      repCount,
    );
    m.applyDiff({ selectedRepresentations: Uint32Array.from(coarsenedSel) }, diff, counter);
  }
  // A single-group transition must touch STRICTLY FEWER than the whole graph whenever `foldRep`'s
  // subtree is a proper minority (the rest of the graph is never visited). For a degenerate
  // hierarchy where the only internal rep IS effectively the whole graph, touching all of it is
  // legitimate — so the strict bound applies only when the chosen subtree is a real minority.
  const localMinority = foldRep !== -1 && foldLeaves * 2 < totalNodes;
  const noWholeGraphRescan = localMinority
    ? counter.nodesScanned < totalNodes
    : counter.nodesScanned <= totalNodes && counter.edgesScanned <= totalEdges;

  // Bootstrap (coarsest) cut card cost — must be ≤ hardCards (B1 invariant a: a high-orphan /
  // huge-flat-community graph must START budget-feasible, since refinement only ADDS cards).
  const bootstrapCards = bootstrapCut(first.repRuntime.hierarchy).cardCost;

  // ── P4 stress metrics 5–8: the P3-orchestration readouts (rejected opens, camera→commit
  // latency, stale jobs, peak cache memory). These exercise the SAME P3 layers the live canvas
  // drives — the solver's forced-open arbitration (LimitedDetail), the IncrementalMaterializer's
  // commit, the ReadinessController's staleness verdict, and the BoundedLayoutCache's byte cap —
  // so the bench reports real numbers, not placeholders. ──

  // Metric 5 — REJECTED explicit opens by budget category. Force-open EVERY root group at a
  // TIGHT card budget the opens jointly bust: the solver honors what fits in arbitration order
  // and retains the rest at the nearest proxy, emitting one LimitedDetail per rejected open
  // naming the limiting budget. (At the production budget nothing is rejected — the tight budget
  // is what makes this metric exercise the arbitration path, exactly as a dense real repo would.)
  const allOpenIntent: CollapseIntent = new Map();
  for (let i = 0; i < snap.roots.length; i++) {
    allOpenIntent.set(snap.groupIds[snap.roots[i]], "open");
  }
  const tightOpts = { ...OPTS, maxCards: 3, nodeBudget: 3 };
  const rejected = buildSceneRepresentationCut({
    ...baseInput,
    boxes: boxesFor(snap),
    cam: camIn,
    intent: allOpenIntent,
    options: tightOpts,
    runtime: undefined, // a fresh runtime: the tight budget is a different material? no — camera/
    // intent/budget drive a recut, not a rebuild; pass no runtime so this solve is independent
    // of `first` and cannot perturb the timed runtime above.
  });

  // Metric 6 — time from CAMERA MOVE to COMMITTED refinement. Time the work between a camera
  // move producing a pending refinement and the IncrementalMaterializer committing it: the
  // single-group refine (re-open `foldRep`, the dual of the coarsen measured above). This is the
  // P3 perf objective's "cached refinement < 16 ms" — the cached path, no async layout.
  let cameraToCommitMs = 0;
  if (foldRep !== -1) {
    const refineDiff: CutDiff = diffCuts(
      Uint32Array.from(coarsenedSel),
      Uint32Array.from(fineSel),
      repCount,
    );
    const timed = await timeIt(() => {
      const m = new IncrementalMaterializer(materialIn);
      // prime to the coarsened scene (untimed setup is amortized across iters but cheap), then
      // commit the one-group refine — the camera→commit critical path.
      m.applyDiff(
        { selectedRepresentations: Uint32Array.from(coarsenedSel) },
        diffCuts([], Uint32Array.from(coarsenedSel), repCount),
      );
      m.applyDiff({ selectedRepresentations: Uint32Array.from(fineSel) }, refineDiff);
    }, 5);
    cameraToCommitMs = timed.median;
  }

  // Metric 7 — STALE local-layout jobs discarded (B3 rule 6). Drive the ReadinessController
  // through a generation bump: a refine-miss issues an async layout at gen N; the camera moves
  // on (gen N+1) before the worker returns; the late result is judged stale and dropped. Count
  // the results the controller refused to commit because their generation was superseded.
  let staleLayoutJobsDiscarded = 0;
  {
    const ctrl = new ReadinessController();
    const root = foldRep === -1 ? (anyInternal === -1 ? 0 : anyInternal) : foldRep;
    ctrl.beginGeneration(1);
    ctrl.track(root, 1); // async layout issued at gen 1
    ctrl.beginGeneration(2); // camera moved on → the gen-1 request is now obsolete
    // The worker's gen-1 result lands AFTER the cut advanced to gen 2 → not committable.
    const verdict = ctrl.resolve(root, 1);
    if (verdict === "stale-generation" || verdict === "cancelled") staleLayoutJobsDiscarded++;
  }

  // Metric 8 — PEAK local-layout cache MEMORY (P3 "cache memory limit / LRU"). Fill a bounded
  // cache with one synthetic local layout per refinable proxy, sampling the high-water byte mark
  // after each insert. The cache's byte cap bounds the peak; this reports the peak actually
  // reached for THIS mode's proxy population (real layouts are larger, but the harness has no
  // engine — the synthetic entry's size is deterministic and the metric is the cache's own
  // byteSize accounting, which the live path uses verbatim).
  let peakLayoutCacheBytes = 0;
  {
    const cache = new BoundedLayoutCache();
    for (let rep = 0; rep < repCount; rep++) {
      if (cols.firstChildByRep[rep] === -1) continue; // only proxies get a local layout
      const layout = synthLayout(subtreeLeaves(rep));
      cache.set(`${mode}:${rep}`, layout);
      if (cache.byteSize > peakLayoutCacheBytes) peakLayoutCacheBytes = cache.byteSize;
    }
  }

  // Fold metrics 1–8 + invariants through the observability collector (the single source the
  // canvas overlay also reads), seeding it with the counters this harness just measured.
  const stress: RepLodStressMetrics = collectStressMetrics(first, MAX_FANOUT, bootstrapCards, {
    materializeCounter: counter,
    cameraToCommitMs,
    staleLayoutJobsDiscarded,
    peakLayoutCacheBytes,
    totalOriginalEdges: totalEdges,
  });

  const validAntichainOk =
    validAntichain(first, visibleCount) &&
    cameraMoves.every((m) => validAntichain(m, visibleCount));
  const finiteBudget = [
    first.budget.targetCards,
    first.budget.hardCards,
    first.budget.targetLayoutCost,
    first.budget.hardLayoutCost,
    first.budget.targetEdges,
    first.budget.hardEdges,
    first.budget.targetLabels,
    first.budget.hardLabels,
    first.budget.maxGpuBytes,
  ].every((v) => Number.isFinite(v));
  const fanout = maxFanout(first);
  const edgesFinite = Number.isFinite(repEdges) && repEdges <= first.budget.hardEdges;

  const cutover =
    sameHierarchy && // no whole-graph rescan on a camera recut (persistent runtime)
    !globalRelayoutOnCamera && // no global layout on a camera move
    finiteBudget &&
    bootstrapCards <= first.budget.hardCards && // budget-feasible bootstrap (B1 invariant a)
    fanout <= MAX_FANOUT && // bounded tiers (B1 invariant b)
    validAntichainOk && // every visible node represented exactly once
    noWholeGraphRescan && // incremental refine bounded by the changed region (Gap 9)
    first.cut.selectedRepresentations.length <= first.budget.hardCards; // finite hard budget

  return {
    mode,
    filtered,
    nodes: visibleCount,
    reps: repCount,
    maxFanout: fanout,
    bootstrapCards,
    hardCards: first.budget.hardCards,
    repCardsZoomIn,
    // The C1a oracle is gone (spec P5): the cut's quality is now asserted in ABSOLUTE terms —
    // the committed card count is BOUNDED (≤ hardCards) AND the cut is a valid antichain (every
    // visible node represented exactly once, real aggregation rather than sprawl).
    cardsWithinBudget:
      repCardsZoomIn <= first.budget.hardCards && validAntichainOk ? "✓(bounded)" : "over",
    repEdges,
    edgesFinite,
    cutSolveMs: cutSolve.median,
    sceneBuildMs: sceneBuild.median,
    layoutMs: layout.median,
    repGlobalMoves,
    cameraMoveCount, // camera moves the persistent runtime absorbed without an O(N) rebuild
    intentDescends,
    intentValid,
    validAntichain: validAntichainOk,
    refineNodesScanned: counter.nodesScanned,
    refineEdgesScanned: counter.edgesScanned,
    totalNodes,
    totalEdges,
    noWholeGraphRescan,
    globalRelayoutOnCamera,
    cutover,
    // ── stress metrics 5–8 + invariants ──
    rejectedOpens: rejectedOpensByCategory(rejected.limitedDetails),
    cameraToCommitMs,
    staleLayoutJobsDiscarded,
    peakLayoutCacheBytes,
    refineBoundedBySubtree: stress.refineBoundedBySubtree,
    fanoutWithinBound: stress.fanoutWithinBound,
    bootstrapFeasible: stress.bootstrapFeasible,
  };
}

/**
 * Run the full parity / cutover bench over every mode × {full, filtered}. Exported so the
 * CI-gated test (`lib/graph/lod-parity-bench.test.ts`) asserts the SAME rows the CLI prints —
 * the report and the gate can never diverge. `progress` is an optional per-row log sink.
 */
export async function runParityBench(progress?: (line: string) => void): Promise<ParityRow[]> {
  const graph = makeRepo(18, 10); // 180 files across 18 dirs — multi-tier in every mode
  const rows: ParityRow[] = [];
  for (const filtered of [false, true]) {
    for (const mode of MODES) {
      progress?.(`  parity ${mode}${filtered ? " (filtered)" : ""}…`);
      rows.push(await benchMode(mode, graph, filtered));
    }
  }
  return rows;
}

/** "✓"/"✗" for a boolean cell. */
function tick(b: boolean): string {
  return b ? "✓" : "✗";
}

/** A compact "cards=N edges=M …" summary of the rejected-opens histogram (metric 5). */
function rejectedSummary(h: RejectedOpensByCategory): string {
  if (h.total === 0) return "0";
  const parts: string[] = [];
  for (const k of ["cards", "edges", "labels", "gpu", "layout"] as const) {
    if (h[k] > 0) parts.push(`${k}=${h[k]}`);
  }
  return `${h.total} (${parts.join(" ")})`;
}

/** console.table() the readable cut report + cutover tables + the one-line verdict. */
export function printParityReport(rows: ParityRow[]): void {
  // ── headline: committed visible cards + edges + timings, per mode × filter ──
  console.log("\n=== LOD REPRESENTATION CUT — committed scene at the production budget ===\n");
  console.table(
    rows.map((r) => ({
      mode: `${r.mode}${r.filtered ? " ·filt" : ""}`,
      nodes: r.nodes,
      reps: r.reps,
      "cards rep": r.repCardsZoomIn,
      "≤ hard": `${r.repCardsZoomIn}≤${r.hardCards}`,
      bounded: r.cardsWithinBudget,
      "edges rep": r.repEdges,
      "solve ms": round(r.cutSolveMs),
      "scene ms": round(r.sceneBuildMs),
      "layout ms": round(r.layoutMs),
    })),
  );

  // ── the CUTOVER table: the conditions that must ALL hold (re-proven each run) ──
  console.log("\n=== CUTOVER CONDITION (every cell must be ✓) ===\n");
  console.table(
    rows.map((r) => ({
      mode: `${r.mode}${r.filtered ? " ·filt" : ""}`,
      "valid antichain": r.validAntichain ? "✓" : "✗",
      "bootstrap ≤ hard": `${r.bootstrapCards}≤${r.hardCards}`,
      "max fanout ≤32": r.maxFanout,
      "rep global moves": r.repGlobalMoves,
      "no cam relayout": r.globalRelayoutOnCamera ? "✗" : "✓",
      "refine nodes/all": `${r.refineNodesScanned}/${r.totalNodes}`,
      "refine edges/all": `${r.refineEdgesScanned}/${r.totalEdges}`,
      "intent descends": r.intentDescends ? "✓" : "✗",
      CUTOVER: r.cutover ? "✓" : "✗",
    })),
  );

  // ── the eight P4 STRESS METRICS, per mode × filter (spec P4 "New stress metrics") ──
  console.log("\n=== P4 STRESS METRICS (the eight P4 readouts + invariants) ===\n");
  console.table(
    rows.map((r) => ({
      mode: `${r.mode}${r.filtered ? " ·filt" : ""}`,
      "1·nodes/recut": `${r.refineNodesScanned}/${r.totalNodes}`,
      "2·edges/recut": `${r.refineEdgesScanned}/${r.totalEdges}`,
      "3·maxFanout": r.maxFanout,
      "4·boot/hard": `${r.bootstrapCards}/${r.hardCards}`,
      "5·rejected (by cat)": rejectedSummary(r.rejectedOpens),
      "6·cam→commit ms": round(r.cameraToCommitMs),
      "7·stale jobs": r.staleLayoutJobsDiscarded,
      "8·peak cache B": r.peakLayoutCacheBytes,
      "inv: bounded/fanout/boot": `${tick(r.refineBoundedBySubtree)}${tick(
        r.fanoutWithinBound,
      )}${tick(r.bootstrapFeasible)}`,
    })),
  );

  const allCutover = rows.every((r) => r.cutover);
  const allBounded = rows.every((r) => r.cardsWithinBudget === "✓(bounded)");
  console.log(
    `\nVERDICT: cutover ${allCutover ? "✓ READY" : "✗ NOT READY"} · ` +
      `cards ${allBounded ? "✓ bounded (≤ hardCards) + valid antichain in every mode" : "✗ a mode exceeded budget"} · ` +
      `rep camera-induced global layout moves: ${rows.reduce((s, r) => s + r.repGlobalMoves, 0)} (target 0)\n`,
  );
}

async function main(): Promise<void> {
  const rows = await runParityBench((line) => process.stderr.write(`${line}\n`));
  printParityReport(rows);

  mkdirSync(`${import.meta.dir}/results`, { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(rows, null, 2)}\n`);
  process.stderr.write(`  wrote ${RESULTS}\n`);

  if (!rows.every((r) => r.cutover)) {
    process.stderr.write("  CUTOVER NOT READY — a mode failed a cutover condition.\n");
    process.exit(1);
  }
}

// Run as a CLI only when invoked directly (`bun run bench/lod-parity.ts`); importing the module
// (the CI-gated test) does NOT trigger the run / file write / process.exit.
if (import.meta.main) void main();
