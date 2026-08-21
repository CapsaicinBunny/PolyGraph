// Incremental proxy materialization (design impl point 4 / Gap 9 / B3). Proves the P1
// merge-gate (gate 15): a single-group refinement updates ONLY the changed subtree — it does
// NOT rescan all original nodes or all original edges. The {@link MaterializeCounter} makes the
// touched work observable, so the bound is asserted directly, not inferred from timing.
//
// Also proves PARITY: the incremental fold produces the SAME scene (nodes + aggregated edges)
// the full {@link materializeProxyScene} would, across a refine and a coarsen, and that the
// internal-edge density stat is maintained incrementally.

import { describe, expect, test } from "bun:test";
import {
  buildProxyEdgeInputs,
  type CutDiff,
  diffCuts,
  IncrementalMaterializer,
  isProxyId,
  type MaterializeCounter,
  materializeProxyScene,
  proxyNodeId,
} from "./proxy-materialize";
import { IncrementalSceneSession } from "./scene";
import { buildFlatGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy } from "./representation";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path.split("/").pop() ?? path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// Three flat groups A/B/C. A and B each own MANY leaves so refining ONE group is a large,
// isolated subtree; C is a small bystander whose nodes/edges must NOT be scanned on that recut.
const groupOf: Record<string, "A" | "B" | "C"> = {};
const nodes = [];
for (let i = 0; i < 6; i++) {
  const id = `A/f${i}.ts`;
  groupOf[id] = "A";
  nodes.push(file(id));
}
for (let i = 0; i < 6; i++) {
  const id = `B/f${i}.ts`;
  groupOf[id] = "B";
  nodes.push(file(id));
}
for (let i = 0; i < 6; i++) {
  const id = `C/f${i}.ts`;
  groupOf[id] = "C";
  nodes.push(file(id));
}

const edges = [
  makeEdge("A/f0.ts", "A/f1.ts", "call"), // internal to A
  makeEdge("A/f1.ts", "A/f2.ts", "call"), // internal to A
  makeEdge("A/f0.ts", "B/f0.ts", "import"), // A → B (boundary)
  makeEdge("B/f0.ts", "B/f1.ts", "call"), // internal to B
  makeEdge("B/f2.ts", "C/f0.ts", "import"), // B → C (boundary, far from A)
  makeEdge("C/f0.ts", "C/f1.ts", "call"), // internal to C
];

const graph: GraphModel = { nodes, edges };
const nodeIds = graph.nodes.map((n) => n.id);
const ordinalOf = (id: string) => nodeIds.indexOf(id);
const edgeInputs = buildProxyEdgeInputs(graph, (id) => {
  const i = ordinalOf(id);
  return i === -1 ? undefined : i;
});

const snap = buildFlatGroupingSnapshot(nodeIds, "facet:g", (id) => {
  const g = groupOf[id];
  return g ? { id: `g:${g}`, boxKey: `g:${g}`, label: g } : null;
});
const hierarchy = buildRepresentationHierarchy(snap, nodeIds);
const groupCount = snap.groupIds.length;
const repA = snap.groupIds.indexOf("g:A");
const repB = snap.groupIds.indexOf("g:B");
const repC = snap.groupIds.indexOf("g:C");
const leafRepOf = (id: string) => groupCount + ordinalOf(id);

/** The fully-folded coarse cut: all three group reps. */
const coarseCut = { selectedRepresentations: [repA, repB, repC] };
/** Refine group A: replace repA with A's leaf reps; B and C stay folded. */
const refineACut = {
  selectedRepresentations: [
    repB,
    repC,
    ...Object.keys(groupOf)
      .filter((id) => groupOf[id] === "A")
      .map(leafRepOf),
  ],
};

const sceneIds = (m: GraphModel) => m.nodes.map((n) => n.id).sort();
const sceneEdges = (m: GraphModel) =>
  m.edges.map((e) => `${e.source}->${e.target}:${e.kind}:${e.count}`).sort();

describe("diffCuts — changed subtree roots between two committed cuts", () => {
  test("a refine moves the opened proxy to `refined`, keeps the rest `unchanged`", () => {
    const diff = diffCuts(
      coarseCut.selectedRepresentations,
      refineACut.selectedRepresentations,
      hierarchy.repCount,
    );
    expect([...diff.refined].sort((a, b) => a - b)).toEqual([repA]); // A opened
    expect([...diff.unchanged].sort((a, b) => a - b)).toEqual([repB, repC].sort((a, b) => a - b));
    // The newly-selected A leaf reps are `coarsened` (newly in the cut).
    expect(diff.coarsened.length).toBe(6);
  });

  test("the reverse (coarsen A) swaps refined/coarsened", () => {
    const diff = diffCuts(
      refineACut.selectedRepresentations,
      coarseCut.selectedRepresentations,
      hierarchy.repCount,
    );
    expect([...diff.coarsened].sort((a, b) => a - b)).toEqual([repA]); // A folded back
    expect(diff.refined.length).toBe(6); // the A leaf reps left the cut
  });
});

describe("incremental materializer — parity with the full fold", () => {
  test("after a refine, the incremental scene equals the full fold", () => {
    const mat = new IncrementalMaterializer({ hierarchy, cut: coarseCut, graph, edgeInputs });
    mat.materializeFull(coarseCut); // baseline
    const diff = diffCuts(
      coarseCut.selectedRepresentations,
      refineACut.selectedRepresentations,
      hierarchy.repCount,
    );
    const incremental = mat.applyDiff(refineACut, diff);
    const full = materializeProxyScene({ hierarchy, cut: refineACut, graph, edgeInputs });
    expect(sceneIds(incremental)).toEqual(sceneIds(full));
    expect(sceneEdges(incremental)).toEqual(sceneEdges(full));
  });

  test("after a refine THEN a coarsen, the scene returns byte-identical to the coarse fold", () => {
    const mat = new IncrementalMaterializer({ hierarchy, cut: coarseCut, graph, edgeInputs });
    mat.materializeFull(coarseCut);
    const d1 = diffCuts(
      coarseCut.selectedRepresentations,
      refineACut.selectedRepresentations,
      hierarchy.repCount,
    );
    mat.applyDiff(refineACut, d1);
    const d2 = diffCuts(
      refineACut.selectedRepresentations,
      coarseCut.selectedRepresentations,
      hierarchy.repCount,
    );
    const backToCoarse = mat.applyDiff(coarseCut, d2);
    const full = materializeProxyScene({ hierarchy, cut: coarseCut, graph, edgeInputs });
    expect(sceneIds(backToCoarse)).toEqual(sceneIds(full));
    expect(sceneEdges(backToCoarse)).toEqual(sceneEdges(full));
  });

  test("internal-edge density stats are maintained incrementally", () => {
    const mat = new IncrementalMaterializer({ hierarchy, cut: coarseCut, graph, edgeInputs });
    mat.materializeFull(coarseCut);
    // Coarse: A folds 2 internal edges, B 1, C 1.
    expect(mat.internalEdgeCount(repA)).toBe(2);
    expect(mat.internalEdgeCount(repB)).toBe(1);
    expect(mat.internalEdgeCount(repC)).toBe(1);
    const diff = diffCuts(
      coarseCut.selectedRepresentations,
      refineACut.selectedRepresentations,
      hierarchy.repCount,
    );
    mat.applyDiff(refineACut, diff);
    // A is now open → its leaves are their own nodes, so A has NO internal proxy density; B and C
    // are untouched (byte-identical).
    expect(mat.internalEdgeCount(repA)).toBe(0);
    expect(mat.internalEdgeCount(repB)).toBe(1);
    expect(mat.internalEdgeCount(repC)).toBe(1);
  });
});

describe("MERGE GATE (gate 15) — a single-group refine does NOT scan all nodes/edges", () => {
  test("touched work is bounded by the changed subtree, not the whole graph", () => {
    const mat = new IncrementalMaterializer({ hierarchy, cut: coarseCut, graph, edgeInputs });
    // Baseline full fold DOES scan everything (this is the O(N) path the recut avoids).
    const baseline: MaterializeCounter = { nodesScanned: 0, edgesScanned: 0 };
    mat.materializeFull(coarseCut, baseline);
    expect(baseline.nodesScanned).toBe(graph.nodes.length); // 18 — full scan
    expect(baseline.edgesScanned).toBe(graph.edges.length); // 6 — full scan

    // The incremental refine of group A must touch ONLY A's subtree (6 nodes) + the edges
    // incident to those 6 nodes (A's 2 internal + the 1 A→B boundary = 3), NEVER all 18/6.
    const diff = diffCuts(
      coarseCut.selectedRepresentations,
      refineACut.selectedRepresentations,
      hierarchy.repCount,
    );
    const recut: MaterializeCounter = { nodesScanned: 0, edgesScanned: 0 };
    mat.applyDiff(refineACut, diff, recut);

    const changedSubtreeNodes = 6; // group A's leaves
    expect(recut.nodesScanned).toBe(changedSubtreeNodes);
    expect(recut.nodesScanned).toBeLessThan(graph.nodes.length); // did NOT scan all nodes

    // Edges incident to A's nodes: f0-f1, f1-f2 (internal), f0→B/f0 (boundary). The B→C and
    // C internal edges (incident only to B/C) are NOT scanned.
    expect(recut.edgesScanned).toBe(3);
    expect(recut.edgesScanned).toBeLessThan(graph.edges.length); // did NOT scan all edges
  });
});

describe("IncrementalSceneSession (scene.ts wiring) — drives full-then-incremental folds", () => {
  test("first recut is the full fold; a second recut diffs and matches the full materializer", () => {
    const session = new IncrementalSceneSession(graph, hierarchy);
    // Diff is null before any baseline.
    expect(session.peekDiff(coarseCut)).toBe(null);
    const first = session.recut(coarseCut);
    const fullCoarse = materializeProxyScene({ hierarchy, cut: coarseCut, graph, edgeInputs });
    expect(sceneIds(first)).toEqual(sceneIds(fullCoarse));

    const peeked = session.peekDiff(refineACut) as CutDiff;
    expect([...peeked.refined]).toEqual([repA]);
    const second = session.recut(refineACut);
    const fullRefine = materializeProxyScene({ hierarchy, cut: refineACut, graph, edgeInputs });
    expect(sceneIds(second)).toEqual(sceneIds(fullRefine));
    expect(sceneEdges(second)).toEqual(sceneEdges(fullRefine));
    // The refined scene drops A's proxy card and renders A's leaves verbatim.
    const ids = new Set(second.nodes.map((n) => n.id));
    expect(ids.has(proxyNodeId(repA))).toBe(false);
    expect(ids.has("A/f0.ts")).toBe(true);
    expect(ids.has(proxyNodeId(repB))).toBe(true); // B still folded
    expect(second.nodes.filter((n) => isProxyId(n.id)).length).toBe(2); // B + C proxies
  });
});
