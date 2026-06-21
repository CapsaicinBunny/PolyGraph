// Representation-LOD benchmark (spec Appendix A §L). Measures, per committed generation,
// the cut-solve time, edge remap+aggregate time, and (sanity) the antichain validity, over
// the C1b fixtures: ~1k / ~25k / ~150k synthetic, plus DENSE / DEEP / WIDE shapes. Prints a
// table and writes bench/results/rep-lod.json. NOT gated against committed baselines (it is
// a tuning/observability harness, not a CI gate) — run it on demand:
//
//   bun run bench/rep-lod.ts
//
// (1.3M is reachable by bumping SIZES but is slow under Bun; the headline scale row is 150k.)

import { mkdirSync, writeFileSync } from "node:fs";
import { directoryGrouping } from "../lib/graph/grouping";
import { buildGroupingSnapshot } from "../lib/graph/grouping-snapshot";
import {
  buildRepresentationHierarchy,
  type RepresentationHierarchy,
} from "../lib/graph/representation";
import {
  bootstrapCut,
  type CameraState,
  cutFromSelection,
  type LodBudget,
  solveLodCut,
} from "../lib/graph/lod-cut-solver";
import { aggregateLodEdges, type LodEdgeInput } from "../lib/graph/lod-edge";
import {
  makeDenseGraph,
  makeDeepGraph,
  makeSyntheticGraph,
  makeWideGraph,
} from "./synthetic";
import { round, timeIt } from "./metrics";
import type { GraphModel } from "../lib/graph/types";

const RESULTS = `${import.meta.dir}/results/rep-lod.json`;

interface Row {
  id: string;
  nodes: number;
  edges: number;
  groups: number;
  reps: number;
  hierarchyMs: number;
  solveMs: number;
  edgeAggMs: number;
  selectedReps: number;
  validAntichain: boolean;
}

const BUDGET: LodBudget = {
  targetNodes: 2000,
  targetEdges: 4000,
  targetLabels: 2000,
  hardNodes: 50_000,
  hardEdges: 200_000,
  hardLabels: 50_000,
  maxGpuBytes: Infinity,
  maxLayoutWork: 200_000,
};

/** Map a graph's edges to the aggregator's ordinal/integer-kind input shape. */
function edgeInputs(graph: GraphModel): { edges: LodEdgeInput[]; ordOf: Map<string, number> } {
  const ordOf = new Map<string, number>();
  graph.nodes.forEach((n, i) => ordOf.set(n.id, i));
  const edges: LodEdgeInput[] = [];
  for (const e of graph.edges) {
    const s = ordOf.get(e.source);
    const t = ordOf.get(e.target);
    if (s === undefined || t === undefined) continue;
    edges.push({ source: s, target: t, kind: 0, count: e.count, exactCount: e.count });
  }
  return { edges, ordOf };
}

/** Verify every node is represented exactly once by the cut (correctness at scale). */
function isValidAntichain(h: RepresentationHierarchy, selected: Set<number>): boolean {
  const { parentByRep, leafRepresentationByNode } = h.columns;
  for (let i = 0; i < leafRepresentationByNode.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = h.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    if (hits !== 1) return false;
  }
  return true;
}

async function benchOne(id: string, graph: GraphModel): Promise<Row> {
  const big = graph.nodes.length > 50_000;
  const iters = big ? 2 : graph.nodes.length > 5000 ? 3 : 6;
  const nodeIds = graph.nodes.map((n) => n.id);

  const hierarchy = await timeIt(
    () => buildRepresentationHierarchy(buildGroupingSnapshot(directoryGrouping(graph), id, nodeIds), nodeIds),
    iters,
  );
  const h = buildRepresentationHierarchy(
    buildGroupingSnapshot(directoryGrouping(graph), id, nodeIds),
    nodeIds,
  );

  const cam: CameraState = { x: 0, y: 0, scale: 0.5, viewport: { w: 1600, h: 900 } };
  const solve = await timeIt(() => solveLodCut(h, bootstrapCut(h), { forceClosed: new Set(), forceOpen: new Set() }, cam, BUDGET), iters);
  const cut = solveLodCut(h, bootstrapCut(h), { forceClosed: new Set(), forceOpen: new Set() }, cam, BUDGET);

  const { edges } = edgeInputs(graph);
  const edgeAgg = await timeIt(() => aggregateLodEdges(h, cut, edges, nodeIds.length), iters);

  // A fully-refined cut is the strictest antichain check (every leaf selected).
  const leaves = nodeIds.map((_, i) => h.columns.leafRepresentationByNode[i]);
  const fullCut = cutFromSelection(h, leaves, 0);

  return {
    id,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    groups: h.snapshot.groupIds.length,
    reps: h.repCount,
    hierarchyMs: hierarchy.median,
    solveMs: solve.median,
    edgeAggMs: edgeAgg.median,
    selectedReps: cut.selectedRepresentations.length,
    validAntichain:
      isValidAntichain(h, new Set(cut.selectedRepresentations)) &&
      isValidAntichain(h, new Set(fullCut.selectedRepresentations)),
  };
}

async function main(): Promise<void> {
  const fixtures: { id: string; graph: GraphModel }[] = [
    { id: "syn-1k", graph: makeSyntheticGraph(1000) },
    { id: "syn-25k", graph: makeSyntheticGraph(25_000) },
    { id: "syn-150k", graph: makeSyntheticGraph(150_000) },
    { id: "dense-10k", graph: makeDenseGraph(10_000, 16) },
    { id: "deep-25k", graph: makeDeepGraph(25_000, 40) },
    { id: "wide-5k-groups", graph: makeWideGraph(5000, 4) },
  ];

  const rows: Row[] = [];
  for (const fx of fixtures) {
    process.stderr.write(`  rep-lod ${fx.id} (${fx.graph.nodes.length} nodes)…\n`);
    rows.push(await benchOne(fx.id, fx.graph));
  }

  console.table(
    rows.map((r) => ({
      fixture: r.id,
      nodes: r.nodes,
      edges: r.edges,
      groups: r.groups,
      reps: r.reps,
      hierarchyMs: round(r.hierarchyMs),
      solveMs: round(r.solveMs),
      edgeAggMs: round(r.edgeAggMs),
      selReps: r.selectedReps,
      valid: r.validAntichain ? "✓" : "✗",
    })),
  );

  mkdirSync(`${import.meta.dir}/results`, { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(rows, null, 2)}\n`);
  process.stderr.write(`  wrote ${RESULTS}\n`);

  if (rows.some((r) => !r.validAntichain)) {
    process.stderr.write("  INVALID antichain at scale!\n");
    process.exit(1);
  }
}

void main();
