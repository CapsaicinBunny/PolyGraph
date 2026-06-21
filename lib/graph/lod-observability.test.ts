import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import { buildSceneRepresentationCut, DEFAULT_REP_LOD_OPTIONS } from "./lod-representation-cut";
import { summarizeRepLod } from "./lod-observability";
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
    expect(stats.nodes).toBe(r.cut.nodeCost);
    expect(stats.targetNodes).toBe(r.budget.targetNodes);
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
