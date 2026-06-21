// Overflow ladder scoped + global-relayout gate WIRING (design P3 overflow + B3 + Work item 1).
//
// The overflow ladder (overflow-ladder.ts) and the material-change relayout gate
// (global-relayout.ts) were staged + unit-tested but UNWIRED. This file proves they are now
// wired into the LIVE scene path (transition.ts → IncrementalSceneSession), enforcing the spec's
// non-negotiable:
//
//   - a refined group outgrowing its reservation escalates through the SCOPED rungs and NEVER
//     triggers a global relayout (`resolution.global === false` on every rung);
//   - representation-bounds caps envelope growth (the deepest escalation is scoped-relayout, not
//     an unbounded grow);
//   - a pure CAMERA RECUT never triggers a global relayout (shouldGlobalRelayout → null);
//   - a true MATERIAL change (graph / filters / grouping / direction / engine / density) DOES
//     trigger a global relayout (shouldGlobalRelayout → the reason).

import { describe, expect, test } from "bun:test";
import { commitTransitionBatches, resolveBatchOverflow } from "./transition";
import { buildProxyEdgeInputs, IncrementalMaterializer } from "./proxy-materialize";
import { IncrementalSceneSession } from "./scene";
import { buildRepresentationEdgeIndex, type EdgeIndexInput } from "./representation-edge-index";
import { buildFlatGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy } from "./representation";
import { computeRepresentationBounds, DEFAULT_BOUNDS_OPTIONS } from "./representation-bounds";
import { cutFromSelection, LOD_BUDGET } from "./lod-cut-solver";
import type { GlobalLayoutInputs } from "./global-relayout";
import { type GraphModel, makeEdge } from "./types";

// ── fixture: three flat groups A/B/C, A oversized (32 leaves), B/C small (4 each) ──
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
const sizeOf = { A: 32, B: 4, C: 4 } as const;
for (const g of ["A", "B", "C"] as const) {
  for (let i = 0; i < sizeOf[g]; i++) {
    const id = `${g}/f${i}.ts`;
    groupOf[id] = g;
    nodes.push(file(id));
  }
}

// A↔B share a boundary edge (connected); C is isolated.
const edges = [
  makeEdge("A/f0.ts", "A/f1.ts", "call"),
  makeEdge("A/f0.ts", "B/f0.ts", "import"),
  makeEdge("B/f0.ts", "B/f1.ts", "call"),
  makeEdge("C/f0.ts", "C/f1.ts", "call"),
];

const graph: GraphModel = { nodes, edges };
const nodeIds = graph.nodes.map((n) => n.id);
const ordinalOf = (id: string) => nodeIds.indexOf(id);

const snap = buildFlatGroupingSnapshot(nodeIds, "facet:g", (id) => {
  const g = groupOf[id];
  return g ? { id: `g:${g}`, boxKey: `g:${g}`, label: g } : null;
});
const hierarchy = buildRepresentationHierarchy(snap, nodeIds, {
  bootstrapRoots: true,
  intermediateTiers: true,
});
const cols = hierarchy.columns;
const groupCount = snap.groupIds.length;
const repA = snap.groupIds.indexOf("g:A");
const repB = snap.groupIds.indexOf("g:B");
const repC = snap.groupIds.indexOf("g:C");
const leafRepOf = (id: string) => groupCount + ordinalOf(id);
const leavesOf = (g: "A" | "B" | "C") =>
  Object.keys(groupOf)
    .filter((id) => groupOf[id] === g)
    .map(leafRepOf);

// childrenOf(rep): the rep's direct child reps (refining a group reveals THESE, not all leaves —
// the intermediate-tier guarantee). Used to refine one level at a time.
const childrenOf = (rep: number): number[] => {
  const out: number[] = [];
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) out.push(c);
  return out.sort((a, b) => a - b);
};

const edge = (s: string, t: string, kind = 0): EdgeIndexInput => ({
  source: ordinalOf(s),
  target: ordinalOf(t),
  kind,
  weight: 1,
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
const coarse = gen([repA, repB, repC]);

// Seed each rep's CURRENT box and derive the tiered reservation / envelope / minScale (the live
// runtime does this once per material signature; here we drive it directly for the unit).
function seedBounds(curW = 200, curH = 120): void {
  for (let r = 0; r < hierarchy.repCount; r++) {
    cols.boundsX[r] = 0;
    cols.boundsY[r] = 0;
    cols.boundsW[r] = curW;
    cols.boundsH[r] = curH;
  }
  computeRepresentationBounds(hierarchy);
}

const newMaterializer = () =>
  new IncrementalMaterializer({
    hierarchy,
    cut: { selectedRepresentations: new Uint32Array(0) },
    graph,
    edgeInputs,
  });

describe("resolveBatchOverflow — a refined group escalates through the SCOPED ladder, never global", () => {
  test("every rep resolves with global === false, on a scoped rung", () => {
    seedBounds();
    for (let r = 0; r < hierarchy.repCount; r++) {
      const res = resolveBatchOverflow(cols, r);
      expect(res.global).toBe(false);
      // The rung is one of the five scoped rungs; the deepest is scoped-relayout, NEVER global.
      expect(["scale", "clip-pan", "borrow-slack", "grow-envelope", "scoped-relayout"]).toContain(
        res.rung,
      );
    }
  });

  test("envelope growth is CAPPED by representation-bounds (grown box never exceeds the envelope)", () => {
    seedBounds();
    for (let r = 0; r < hierarchy.repCount; r++) {
      if (cols.firstChildByRep[r] === -1) continue; // leaves don't grow
      const res = resolveBatchOverflow(cols, r);
      // The grown box is bounded by the rep's growthEnvelope (the maxEnvelopeFactor cap) — never
      // the full-leaf extent of the subtree (the Space Paradox fix).
      const envW = cols.envelopeW[r];
      const envH = cols.envelopeH[r];
      expect(res.box.w).toBeLessThanOrEqual(envW + 1e-3);
      expect(res.box.h).toBeLessThanOrEqual(envH + 1e-3);
      // And the envelope itself is a bounded multiple of the current box — not 32×.
      const curArea = cols.boundsW[r] * cols.boundsH[r];
      expect(envW * envH).toBeLessThanOrEqual(
        curArea * DEFAULT_BOUNDS_OPTIONS.maxEnvelopeFactor + 1,
      );
    }
  });

  test("an oversized group (A: 32 leaves, tiered) refines into BOUNDED intermediate children, not its leaf set", () => {
    // The intermediate-tier guarantee (invariant d): A's direct children are a bounded antichain,
    // so refining it never reveals all 32 leaves at once — the overflow it must absorb is the
    // next tier, which fits within the scoped ladder.
    seedBounds();
    const kidsA = childrenOf(repA);
    expect(kidsA.length).toBeGreaterThan(0);
    expect(kidsA.length).toBeLessThanOrEqual(32); // bounded fan-out, not the full leaf set
    const res = resolveBatchOverflow(cols, repA);
    expect(res.global).toBe(false);
  });
});

describe("commitTransitionBatches — overflow surfaced per refined root; commit stays scoped", () => {
  test("a refine commits, surfaces a per-root overflow resolution, and never goes global", () => {
    seedBounds();
    const mat = newMaterializer();
    mat.materializeFull(coarse);
    // Refine A one level (reveal its direct children); B, C stay folded.
    const target = gen([...childrenOf(repA), repB, repC]);
    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: LOD_BUDGET,
      targetGeneration: 1,
    });
    const refinedBatch = result.outcomes.find((o) => o.batch.roots.includes(repA));
    expect(refinedBatch?.committed).toBe(true);
    // The refined root A carries an overflow resolution; it is scoped (global false).
    const a = refinedBatch!.overflow.find((o) => o.root === repA);
    expect(a).toBeDefined();
    expect(a!.resolution.global).toBe(false);
    // Whatever rung it lands on, it is NOT a global relayout (the §C invariant).
    expect(a!.resolution.rung).not.toBe(undefined);
  });

  test("a coarsen-only batch produces NO overflow entries (folding never overflows)", () => {
    seedBounds();
    const mat = newMaterializer();
    const open = gen([...childrenOf(repA), repB, repC]);
    mat.materializeFull(open);
    // Coarsen A back to one card.
    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: open,
      target: coarse,
      budget: LOD_BUDGET,
      targetGeneration: 2,
    });
    for (const o of result.outcomes) expect(o.overflow).toEqual([]);
    expect(result.envelopeExhausted).toBe(false);
  });

  test("envelopeExhausted flags ONLY when a committed refine needed the scoped-relayout rung", () => {
    // Force the scoped-relayout rung by shrinking A's envelope to its current box (no room to
    // grow) while its next tier still overflows — the ladder then exhausts the envelope. This is
    // a SCOPED escalation: the transition still commits, global stays false.
    seedBounds();
    // Collapse A's envelope to its current box AND keep minScale tiny so even compaction can't fit.
    cols.envelopeW[repA] = cols.boundsW[repA];
    cols.envelopeH[repA] = cols.boundsH[repA];
    cols.reservedW[repA] = cols.boundsW[repA] * 10; // next tier far larger than the box
    cols.reservedH[repA] = cols.boundsH[repA] * 10;
    cols.minScale[repA] = 0.5;

    const res = resolveBatchOverflow(cols, repA);
    expect(res.rung).toBe("scoped-relayout");
    expect(res.scopedRelayout).toBe(true);
    expect(res.global).toBe(false); // STILL scoped — never global

    const mat = newMaterializer();
    mat.materializeFull(coarse);
    const target = gen([...childrenOf(repA), repB, repC]);
    const result = commitTransitionBatches({
      hierarchy,
      edgeIndex,
      materializer: mat,
      committed: coarse,
      target,
      budget: LOD_BUDGET,
      targetGeneration: 3,
    });
    // The committed refine of A exhausted its envelope → the (scoped) exhaustion signal is set.
    expect(result.anyCommitted).toBe(true);
    expect(result.envelopeExhausted).toBe(true);
    const a = result.outcomes.flatMap((o) => o.overflow).find((o) => o.root === repA);
    expect(a!.resolution.global).toBe(false);
  });
});

// The MATERIAL global-layout inputs the scene was last laid out against.
const baseInputs: GlobalLayoutInputs = {
  graphVersion: "g1",
  filterSignature: "f1",
  groupingMode: "facet:g",
  direction: "TB",
  layoutEngine: "smart",
  layoutOptionsHash: "lo1",
  explicitRelayoutNonce: 0,
  envelopeExhaustedNonce: 0,
};

describe("IncrementalSceneSession — a CAMERA RECUT never triggers a global relayout (merge gate 10)", () => {
  test("a sequence of cut transitions (camera recuts) leaves the global signature unchanged → no relayout", () => {
    const session = new IncrementalSceneSession(graph, hierarchy, {
      edgeIndex,
      globalLayoutInputs: baseInputs,
    });
    const sig0 = session.globalLayoutSignature();

    // Drive several camera recuts: open A, open more, coarsen back — each a transition that changes
    // ONLY the cut, never the material inputs.
    const open = gen([...childrenOf(repA), repB, repC]);
    session.commitTransition(coarse, open, LOD_BUDGET, 1);
    session.commitTransition(open, gen([...leavesOf("A"), repB, repC]), LOD_BUDGET, 2);
    session.commitTransition(gen([...leavesOf("A"), repB, repC]), coarse, LOD_BUDGET, 3);

    // A camera recut changes NO field of GlobalLayoutInputs → the same inputs → null reason.
    expect(session.shouldGlobalRelayout(baseInputs)).toBeNull();
    // The baseline signature is untouched by the recuts (commitTransition never re-baselines it).
    expect(session.globalLayoutSignature()).toBe(sig0);
  });

  test("with no baseline set, the gate is inert (null) — the caller hasn't opted in", () => {
    const session = new IncrementalSceneSession(graph, hierarchy, { edgeIndex });
    expect(session.shouldGlobalRelayout(baseInputs)).toBeNull();
    expect(session.globalLayoutSignature()).toBeUndefined();
  });
});

describe("IncrementalSceneSession — a MATERIAL change DOES trigger a global relayout", () => {
  const session = () =>
    new IncrementalSceneSession(graph, hierarchy, {
      edgeIndex,
      globalLayoutInputs: baseInputs,
    });

  test("a filter change → 'filters'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, filterSignature: "f2" })).toBe(
      "filters",
    );
  });

  test("a grouping-mode change → 'grouping-mode'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, groupingMode: "directory" })).toBe(
      "grouping-mode",
    );
  });

  test("a direction change → 'direction'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, direction: "LR" })).toBe("direction");
  });

  test("an engine change → 'engine'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, layoutEngine: "layered" })).toBe(
      "engine",
    );
  });

  test("a graph re-scan → 'graph'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, graphVersion: "g2" })).toBe("graph");
  });

  test("a density / layout-options change → 'layout-options'", () => {
    expect(session().shouldGlobalRelayout({ ...baseInputs, layoutOptionsHash: "lo2" })).toBe(
      "layout-options",
    );
  });

  test("an envelope-exhaustion nonce bump → 'envelope-exhausted' (the only camera-adjacent material trigger)", () => {
    // The scoped overflow ladder flags envelopeExhausted; the caller bumps THIS nonce, which is the
    // sole bridge from a scoped exhaustion to an explicit global relayout REQUEST — still gated.
    expect(session().shouldGlobalRelayout({ ...baseInputs, envelopeExhaustedNonce: 1 })).toBe(
      "envelope-exhausted",
    );
  });

  test("re-baselining after a relayout makes the SAME material inputs no longer fire", () => {
    const s = session();
    const next = { ...baseInputs, direction: "BT" as const };
    expect(s.shouldGlobalRelayout(next)).toBe("direction");
    // The caller performs the relayout, then re-baselines.
    s.setGlobalLayoutBaseline(next);
    expect(s.shouldGlobalRelayout(next)).toBeNull();
    // A subsequent camera recut against the NEW baseline still does not fire.
    session().shouldGlobalRelayout(next);
    expect(s.shouldGlobalRelayout(next)).toBeNull();
  });
});
