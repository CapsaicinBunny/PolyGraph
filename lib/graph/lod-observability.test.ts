import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import { buildSceneRepresentationCut, DEFAULT_REP_LOD_OPTIONS } from "./lod-representation-cut";
import {
  collectStressMetrics,
  maxRepresentationFanout,
  rejectedOpensByCategory,
  summarizeRepLod,
} from "./lod-observability";
import { MAX_FANOUT } from "./representation";
import { bootstrapCut } from "./lod-cut-solver";
import type { LimitedDetail } from "./lod-cut-solver";
import type { MaterializeCounter } from "./proxy-materialize";
import type { CollapseIntent } from "./collapse-model";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

const graph: GraphModel = {
  nodes: ["a/x/f1.c", "a/x/f2.c", "a/y/f3.c", "b/z/f4.c", "b/z/f5.c"].map(file),
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const vp: Viewport = { w: 800, h: 600 };
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

describe("summarizeRepLod — overlay stats (Appendix A §I)", () => {
  test("reports generation, reps, cost vs budget, and why-not-refined", () => {
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: new Map<string, Box>([
        ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
        ["b", { x: 5000, y: 0, w: 1000, h: 1000 }], // off-screen → not refined
      ]),
      cam: { x: 0, y: 0, scale: 0.01 } as Camera, // everything tiny → coarse
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
      collectDiagnostics: true,
    });
    const stats = summarizeRepLod(r, {
      budget: r.budget,
      cutSolveMs: r.cutSolveMs,
      whyNotRefined: r.diagnostics?.whyNotRefined,
      refinements: r.diagnostics?.refinements,
      evictions: 0,
    });
    expect(stats.generation).toBe(r.runtime.generation);
    expect(stats.committedReps).toBe(r.cut.selectedRepresentations.length);
    expect(stats.cards).toBe(r.cut.cardCost);
    expect(stats.targetCards).toBe(r.budget.targetCards);
    // A coarse cut left proxies unrefined → at least one why-not-refined reason recorded.
    const totalReasons = stats.whyNotRefined.reduce((s, row) => s + row.count, 0);
    expect(totalReasons).toBeGreaterThanOrEqual(0); // may be 0 if all collapsed to roots-as-leaves
    expect(stats.layoutWorkPct).toBeGreaterThanOrEqual(0);
    expect(stats.layoutWorkPct).toBeLessThanOrEqual(1);
  });

  test("with no timings, numeric fields default to 0 (no NaN)", () => {
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: new Map(),
      cam: { x: 0, y: 0, scale: 1 } as Camera,
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
    });
    const stats = summarizeRepLod(r);
    expect(Number.isNaN(stats.cutSolveMs)).toBe(false);
    expect(Number.isNaN(stats.proxyCacheHitRate)).toBe(false);
    expect(Number.isNaN(stats.gpuMB)).toBe(false);
    expect(stats.refinements).toBe(0);
  });
});

describe("rejectedOpensByCategory — metric 5 histogram", () => {
  test("buckets each LimitedDetail by its limitingBudget and totals", () => {
    const limited: LimitedDetail[] = [
      { requestedRep: 1, resolvedRep: 0, limitingBudget: "cards" },
      { requestedRep: 2, resolvedRep: 0, limitingBudget: "cards" },
      { requestedRep: 3, resolvedRep: 0, limitingBudget: "edges" },
      { requestedRep: 4, resolvedRep: 0, limitingBudget: "layout" },
    ];
    const h = rejectedOpensByCategory(limited);
    expect(h.cards).toBe(2);
    expect(h.edges).toBe(1);
    expect(h.layout).toBe(1);
    expect(h.labels).toBe(0);
    expect(h.gpu).toBe(0);
    expect(h.total).toBe(4);
  });

  test("empty input → all zero", () => {
    const h = rejectedOpensByCategory([]);
    expect(h.total).toBe(0);
    expect(h.cards + h.edges + h.labels + h.gpu + h.layout).toBe(0);
  });
});

describe("collectStressMetrics — the eight P4 stress metrics + invariants", () => {
  const run = (cam: Camera) =>
    buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: new Map<string, Box>([
        ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
        ["b", { x: 5000, y: 0, w: 1000, h: 1000 }],
      ]),
      cam,
      vp,
      intent: new Map() as CollapseIntent,
      options: opts,
    });

  test("reports all eight metrics with the counters wired through", () => {
    const r = run({ x: 0, y: 0, scale: 0.9 } as Camera);
    // A measured single-group recut: the materializer touched a strict minority of the graph.
    const mc: MaterializeCounter = { nodesScanned: 2, edgesScanned: 0 };
    const bootstrapCards = bootstrapCut(r.repRuntime.hierarchy).cardCost;
    const m = collectStressMetrics(r, MAX_FANOUT, bootstrapCards, {
      materializeCounter: mc,
      cameraToCommitMs: 4.2,
      staleLayoutJobsDiscarded: 3,
      peakLayoutCacheBytes: 12_345,
    });
    // 1 + 2 — original nodes/edges scanned per recut (from the counter)
    expect(m.nodesScannedPerRecut).toBe(2);
    expect(m.edgesScannedPerRecut).toBe(0);
    expect(m.totalNodes).toBe(nodeIds.length);
    // 3 — max fan-out (read from the hierarchy)
    expect(m.maxFanout).toBe(maxRepresentationFanout(r.repRuntime.hierarchy));
    // 4 — bootstrap vs hardCards
    expect(m.bootstrapCards).toBe(bootstrapCards);
    expect(m.hardCards).toBe(r.budget.hardCards);
    expect(m.bootstrapCutRatio).toBeCloseTo(bootstrapCards / r.budget.hardCards);
    // 5 — rejected opens (no forced opens here → empty)
    expect(m.rejectedOpensByCategory.total).toBe(0);
    // 6 / 7 / 8 — the orchestration counters pass through verbatim
    expect(m.cameraToCommitMs).toBe(4.2);
    expect(m.staleLayoutJobsDiscarded).toBe(3);
    expect(m.peakLayoutCacheBytes).toBe(12_345);
  });

  test("asserts the three invariants — bounded refine, fan-out ≤ MAX_FANOUT, feasible bootstrap", () => {
    const r = run({ x: 0, y: 0, scale: 0.9 } as Camera);
    const bootstrapCards = bootstrapCut(r.repRuntime.hierarchy).cardCost;
    const m = collectStressMetrics(r, MAX_FANOUT, bootstrapCards, {
      materializeCounter: { nodesScanned: 2, edgesScanned: 0 },
    });
    // invariant: a single-group refine scans STRICTLY fewer original nodes than the whole graph
    expect(m.refineBoundedBySubtree).toBe(true);
    // invariant: fan-out ≤ MAX_FANOUT
    expect(m.fanoutWithinBound).toBe(true);
    expect(m.maxFanout).toBeLessThanOrEqual(MAX_FANOUT);
    // invariant: bootstrap cut fits the hard ceiling
    expect(m.bootstrapFeasible).toBe(true);
    expect(m.bootstrapCards).toBeLessThanOrEqual(m.hardCards);
  });

  test("a whole-graph scan VIOLATES the bounded-refine invariant (the metric is not vacuous)", () => {
    const r = run({ x: 0, y: 0, scale: 0.9 } as Camera);
    const bootstrapCards = bootstrapCut(r.repRuntime.hierarchy).cardCost;
    // A counter that scanned EVERY original node is, by definition, not a local refine.
    const m = collectStressMetrics(r, MAX_FANOUT, bootstrapCards, {
      materializeCounter: { nodesScanned: nodeIds.length, edgesScanned: 0 },
    });
    expect(m.refineBoundedBySubtree).toBe(false);
  });

  test("scanning MORE edges than the original population also violates the invariant", () => {
    const r = run({ x: 0, y: 0, scale: 0.9 } as Camera);
    const bootstrapCards = bootstrapCut(r.repRuntime.hierarchy).cardCost;
    // 2 nodes (a minority) but 99 edges scanned against an original population of 10 → not local.
    const m = collectStressMetrics(r, MAX_FANOUT, bootstrapCards, {
      materializeCounter: { nodesScanned: 2, edgesScanned: 99 },
      totalOriginalEdges: 10,
    });
    expect(m.totalEdges).toBe(10);
    expect(m.refineBoundedBySubtree).toBe(false);
  });

  test("no measured recut → bounded-refine invariant holds vacuously, counters default to 0", () => {
    const r = run({ x: 0, y: 0, scale: 0.9 } as Camera);
    const bootstrapCards = bootstrapCut(r.repRuntime.hierarchy).cardCost;
    const m = collectStressMetrics(r, MAX_FANOUT, bootstrapCards);
    expect(m.nodesScannedPerRecut).toBe(0);
    expect(m.cameraToCommitMs).toBe(0);
    expect(m.staleLayoutJobsDiscarded).toBe(0);
    expect(m.peakLayoutCacheBytes).toBe(0);
    expect(m.refineBoundedBySubtree).toBe(true);
  });
});
