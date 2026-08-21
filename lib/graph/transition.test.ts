// Transition batches — the connected-transition commit policy (design B3 + impl note (b) +
// Gap 9 CutDiff). Proves:
//   - INDEPENDENT subtrees (no boundary relationship) commit SEPARATELY (one batch each);
//   - CONNECTED subtrees (joined by an affected quotient edge) commit as ONE batch;
//   - a REJECTED batch (would breach a hard ceiling) is a pure NO-OP — both the scene and the
//     committed cut are left unchanged — while independent batches still commit.

import { describe, expect, test } from "bun:test";
import {
  commitTransitionBatches,
  computeCutDiff,
  groupTransitionBatches,
  hardBudgetBreach,
} from "./transition";
import {
  buildProxyEdgeInputs,
  IncrementalMaterializer,
  materializeProxyScene,
} from "./proxy-materialize";
import { IncrementalSceneSession } from "./scene";
import { buildRepresentationEdgeIndex, type EdgeIndexInput } from "./representation-edge-index";
import { buildFlatGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy } from "./representation";
import { cutFromSelection, type LodBudget } from "./lod-cut-solver";
import { LOD_BUDGET } from "./lod-representation-cut";
import { type GraphModel, makeEdge } from "./types";

// ── fixture: three flat groups A/B/C, 4 leaves each ──────────────────────────
const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path.split("/").pop() ?? path,
  filePath: path,
  line: 0,
  parentFile: path,
});

const groupOf: Record<string, "A" | "B" | "C"> = {};
const nodes = [];
for (const g of ["A", "B", "C"] as const) {
  for (let i = 0; i < 4; i++) {
    const id = `${g}/f${i}.ts`;
    groupOf[id] = g;
    nodes.push(file(id));
  }
}

// A↔B share a boundary edge (so they are CONNECTED). C is isolated (no edge to A or B).
const edges = [
  makeEdge("A/f0.ts", "A/f1.ts", "call"), // internal to A
  makeEdge("A/f0.ts", "B/f0.ts", "import"), // A → B (boundary — connects A and B)
  makeEdge("B/f0.ts", "B/f1.ts", "call"), // internal to B
  makeEdge("C/f0.ts", "C/f1.ts", "call"), // internal to C (no cross-group edge)
];

const graph: GraphModel = { nodes, edges };
const nodeIds = graph.nodes.map((n) => n.id);
const ordinalOf = (id: string) => nodeIds.indexOf(id);

const snap = buildFlatGroupingSnapshot(nodeIds, "facet:g", (id) => {
  const g = groupOf[id];
  return g ? { id: `g:${g}`, boxKey: `g:${g}`, label: g } : null;
});
// Build with the SAME normalization the production runtime uses (bootstrapRoots +
// intermediateTiers): the synthetic super-root gives every group a common ancestor, so a
// cross-group edge has an LCA and is indexed (a flat un-normalized forest would drop it as
// disjoint, leaving no quotient edge to relate two groups' subtrees).
const hierarchy = buildRepresentationHierarchy(snap, nodeIds, {
  bootstrapRoots: true,
  intermediateTiers: true,
});
const groupCount = snap.groupIds.length;
const repA = snap.groupIds.indexOf("g:A");
const repB = snap.groupIds.indexOf("g:B");
const repC = snap.groupIds.indexOf("g:C");
const leafRepOf = (id: string) => groupCount + ordinalOf(id);
const leavesOf = (g: "A" | "B" | "C") =>
  Object.keys(groupOf)
    .filter((id) => groupOf[id] === g)
    .map(leafRepOf);

// EdgeIndexInput (by ordinal) for the cut-aware quotient cost + boundary grouping.
const edge = (s: string, t: string, kind = 0, weight = 1): EdgeIndexInput => ({
  source: ordinalOf(s),
  target: ordinalOf(t),
  kind,
  weight,
});
const edgeIndex = buildRepresentationEdgeIndex(hierarchy, [
  edge("A/f0.ts", "A/f1.ts"),
  edge("A/f0.ts", "B/f0.ts", 1),
  edge("B/f0.ts", "B/f1.ts"),
  edge("C/f0.ts", "C/f1.ts"),
]);

const edgeInputs = buildProxyEdgeInputs(graph, (id) => {
  const i = ordinalOf(id);
  return i === -1 ? undefined : i;
});

const gen = (sel: number[]) => cutFromSelection(hierarchy, sel, 1);
const coarse = gen([repA, repB, repC]); // all three folded
const sceneIds = (m: GraphModel) => m.nodes.map((n) => n.id).sort();
const sceneEdges = (m: GraphModel) =>
  m.edges.map((e) => `${e.source}->${e.target}:${e.kind}:${e.count}`).sort();

const newMaterializer = () =>
  new IncrementalMaterializer({
    hierarchy,
    cut: { selectedRepresentations: new Uint32Array(0) },
    graph,
    edgeInputs,
  });

describe("groupTransitionBatches — boundary-relationship partition (impl note b)", () => {
  test("independent changed subtrees (no boundary edge) commit as SEPARATE batches", () => {
    // Refine A and C: A↔C have NO edge between them, so two independent batches.
    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    const diff = computeCutDiff(
      coarse.selectedRepresentations,
      target.selectedRepresentations,
      hierarchy.repCount,
    );
    const batches = groupTransitionBatches(diff, hierarchy, edgeIndex, 7);
    // refined = {repA, repC}; with no A↔C edge they are two distinct components.
    const roots = batches.map((b) => [...b.roots]);
    expect(roots).toContainEqual([repA]);
    expect(roots).toContainEqual([repC]);
    expect(batches.length).toBe(2);
    expect(batches.every((b) => b.targetGeneration === 7)).toBe(true);
  });

  test("connected changed subtrees (joined by an affected quotient edge) commit as ONE batch", () => {
    // Refine A and B: the A→B import edge connects them, so a single batch.
    const target = gen([...leavesOf("A"), ...leavesOf("B"), repC]);
    const diff = computeCutDiff(
      coarse.selectedRepresentations,
      target.selectedRepresentations,
      hierarchy.repCount,
    );
    const batches = groupTransitionBatches(diff, hierarchy, edgeIndex, 3);
    // refined = {repA, repB} are connected → one batch holding both.
    const refinedBatch = batches.find((b) => b.roots.includes(repA));
    expect(refinedBatch).toBeDefined();
    expect([...refinedBatch!.roots].sort((a, b) => a - b)).toEqual(
      [repA, repB].sort((a, b) => a - b),
    );
    // No other batch should also hold one of {A,B} (they are in the SAME component).
    expect(batches.filter((b) => b.roots.includes(repA) || b.roots.includes(repB)).length).toBe(1);
  });

  test("without an edge index, every changed root is its own (independent) batch", () => {
    const target = gen([...leavesOf("A"), ...leavesOf("B"), repC]);
    const diff = computeCutDiff(
      coarse.selectedRepresentations,
      target.selectedRepresentations,
      hierarchy.repCount,
    );
    const batches = groupTransitionBatches(diff, hierarchy, undefined, 0);
    // A and B each become their own batch (no quotient edges to relate them).
    expect(batches.map((b) => [...b.roots])).toContainEqual([repA]);
    expect(batches.map((b) => [...b.roots])).toContainEqual([repB]);
  });
});

describe("commitTransitionBatches — atomic per-batch commit + hard-budget revalidation", () => {
  test("independent batches both commit; the scene matches the full target fold", () => {
    const mat = newMaterializer();
    mat.materializeFull(coarse); // baseline scene reflects the committed (coarse) cut
    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: LOD_BUDGET,
      targetGeneration: 1,
    });
    expect(result.outcomes.length).toBe(2);
    expect(result.outcomes.every((o) => o.committed)).toBe(true);
    expect(result.anyCommitted).toBe(true);
    // Committed selection == the full target.
    expect([...result.committedSelection].sort((a, b) => a - b)).toEqual(
      [...target.selectedRepresentations].sort((a, b) => a - b),
    );
    // Scene equals the full fold of the target cut (parity).
    const full = materializeProxyScene({ hierarchy, cut: target, graph, edgeInputs });
    expect(sceneIds(result.scene)).toEqual(sceneIds(full));
    expect(sceneEdges(result.scene)).toEqual(sceneEdges(full));
  });

  test("a connected pair commits as ONE batch and folds the scene to the target", () => {
    const mat = newMaterializer();
    mat.materializeFull(coarse);
    const target = gen([...leavesOf("A"), ...leavesOf("B"), repC]);
    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: LOD_BUDGET,
      targetGeneration: 2,
    });
    const committedBatch = result.outcomes.find((o) => o.batch.roots.includes(repA));
    expect(committedBatch?.committed).toBe(true);
    expect([...committedBatch!.batch.roots].sort((a, b) => a - b)).toEqual(
      [repA, repB].sort((a, b) => a - b),
    );
    const full = materializeProxyScene({ hierarchy, cut: target, graph, edgeInputs });
    expect(sceneIds(result.scene)).toEqual(sceneIds(full));
    expect(sceneEdges(result.scene)).toEqual(sceneEdges(full));
  });

  test("a REJECTED batch is a no-op: scene + committed cut unchanged, independent batch still commits", () => {
    const mat = newMaterializer();
    mat.materializeFull(coarse);

    // Refine A AND C (two independent batches). A tiny hardCards ceiling lets the smaller
    // candidate through but rejects the one that would push the card count over the limit.
    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    // Coarse cut = 3 cards. Refining A adds 3 (repA→4 leaves: +4-1). Set hardCards so the
    // FIRST-ordered batch fits but the second pushes over. Both A and C refine to 4 leaves
    // (net +3 each). Budget 6: after A (3-1+4=6 cards) it's exactly at hard; C would make 9 → reject.
    const tightBudget: LodBudget = { ...LOD_BUDGET, hardCards: 6 };

    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: tightBudget,
      targetGeneration: 9,
    });

    // Exactly one batch rejected by `cards`, one committed.
    const rejected = result.outcomes.filter((o) => !o.committed);
    const committed = result.outcomes.filter((o) => o.committed);
    expect(rejected.length).toBe(1);
    expect(committed.length).toBe(1);
    expect(rejected[0].rejectedBy).toBe("cards");

    // The committed selection contains the ACCEPTED batch's reps but NOT the rejected batch's
    // refinement — the rejected root stays folded (its proxy rep is still selected).
    const sel = new Set([...result.committedSelection]);
    expect(sel.has(repB)).toBe(true); // unchanged group stays folded
    // The rejected batch's group rep is still folded (never opened); its leaves are NOT selected.
    const rejectedRoot = rejected[0].batch.roots[0];
    expect(sel.has(rejectedRoot)).toBe(true);
    for (const leaf of leavesOf(rejectedRoot === repA ? "A" : "C")) {
      expect(sel.has(leaf)).toBe(false);
    }
    // Card count within the hard ceiling.
    expect(result.committedSelection.length).toBeLessThanOrEqual(tightBudget.hardCards);

    // The scene is exactly the full fold of the PARTIAL committed selection (the accepted batch
    // applied, the rejected one not) — proving the rejected batch left no trace in the scene.
    const partial = cutFromSelection(hierarchy, [...result.committedSelection], 1);
    const full = materializeProxyScene({ hierarchy, cut: partial, graph, edgeInputs });
    expect(sceneIds(result.scene)).toEqual(sceneIds(full));
    expect(sceneEdges(result.scene)).toEqual(sceneEdges(full));
  });

  test("ALL batches rejected → the scene and committed cut are byte-identical to the baseline", () => {
    const mat = newMaterializer();
    const baseline = mat.materializeFull(coarse);
    const baselineIds = sceneIds(baseline);
    const baselineEdges = sceneEdges(baseline);

    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    // hardCards below even the coarse count's first refine → every batch rejected.
    const impossible: LodBudget = { ...LOD_BUDGET, hardCards: 3 };

    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: impossible,
      targetGeneration: 4,
    });

    expect(result.anyCommitted).toBe(false);
    expect(result.outcomes.every((o) => !o.committed)).toBe(true);
    // Committed selection unchanged (== coarse).
    expect([...result.committedSelection].sort((a, b) => a - b)).toEqual(
      [...coarse.selectedRepresentations].sort((a, b) => a - b),
    );
    // Scene byte-identical to the baseline.
    expect(sceneIds(result.scene)).toEqual(baselineIds);
    expect(sceneEdges(result.scene)).toEqual(baselineEdges);
  });
});

describe("hardBudgetBreach — finite ceiling revalidation (impl note b)", () => {
  test("returns null within budget, the breached dimension over it", () => {
    const within = new Set([repA, repB, repC]);
    expect(hardBudgetBreach(hierarchy.columns, edgeIndex, within, LOD_BUDGET)).toBeNull();
    // A 1-card hard ceiling is breached by 3 selected reps.
    const tiny: LodBudget = { ...LOD_BUDGET, hardCards: 1 };
    expect(hardBudgetBreach(hierarchy.columns, edgeIndex, within, tiny)).toBe("cards");
  });

  test("the edge dimension uses the cut-aware quotient count, not an additive sum", () => {
    // Open A and B fully: the A→B import edge becomes a visible quotient edge. With a 0 hardEdges
    // ceiling that one quotient edge breaches `edges` (proving the quotient count is evaluated).
    const open = new Set([...leavesOf("A"), ...leavesOf("B"), repC]);
    const noEdges: LodBudget = { ...LOD_BUDGET, hardEdges: 0 };
    expect(hardBudgetBreach(hierarchy.columns, edgeIndex, open, noEdges)).toBe("edges");
  });
});

describe("IncrementalSceneSession.commitTransition — the scene-path wiring (P3)", () => {
  test("establishes the baseline, commits accepted batches, advances the committed cut", () => {
    const session = new IncrementalSceneSession(graph, hierarchy, { edgeIndex });
    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    // First call (no prior baseline) folds `committed` then commits the transition's batches.
    const result = session.commitTransition(coarse, target, LOD_BUDGET, 5);
    expect(result.anyCommitted).toBe(true);
    expect(result.outcomes.every((o) => o.committed)).toBe(true);
    const full = materializeProxyScene({ hierarchy, cut: target, graph, edgeInputs });
    expect(sceneIds(result.scene)).toEqual(sceneIds(full));

    // A SECOND transition diffs against the advanced committed cut: coarsen everything back.
    const back = session.commitTransition(target, coarse, LOD_BUDGET, 6);
    expect(back.anyCommitted).toBe(true);
    const fullCoarse = materializeProxyScene({ hierarchy, cut: coarse, graph, edgeInputs });
    expect(sceneIds(back.scene)).toEqual(sceneIds(fullCoarse));
    expect(sceneEdges(back.scene)).toEqual(sceneEdges(fullCoarse));
  });

  test("a rejected batch through the session leaves the scene at the partial commit", () => {
    const session = new IncrementalSceneSession(graph, hierarchy, { edgeIndex });
    const target = gen([...leavesOf("A"), repB, ...leavesOf("C")]);
    const tight: LodBudget = { ...LOD_BUDGET, hardCards: 6 };
    const result = session.commitTransition(coarse, target, tight, 1);
    expect(result.outcomes.filter((o) => !o.committed).length).toBe(1);
    const partial = cutFromSelection(hierarchy, [...result.committedSelection], 1);
    const full = materializeProxyScene({ hierarchy, cut: partial, graph, edgeInputs });
    expect(sceneIds(result.scene)).toEqual(sceneIds(full));
    expect(sceneEdges(result.scene)).toEqual(sceneEdges(full));
  });
});
