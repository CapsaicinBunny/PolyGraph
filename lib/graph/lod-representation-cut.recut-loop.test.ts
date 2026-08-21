// REGRESSION: the layout↔cut feedback loop ("constantly cutting" / "Laying out…" never
// clears, especially in Smart mode). Root cause was a live-box dependency in the committed
// cut: the refine gate `canRefine` (and the solver's visibility/arbitration geometry, and
// the eviction `onScreen` test) read the visual engine's LIVE cluster boxes. Stress/Smart are
// non-deterministic — seeded from the previous frame's positions — so those boxes DRIFT every
// layout run and never converge. A drifted box → a different set of reps clears the gate → a
// different cut commits (new generation) → setRepScene → useScene re-runs Stress → the canvas
// scene-ready effect fires recomputeCut again → re-reads the newly-drifted boxes → loops
// UNBOUNDED. The idempotency the canvas relies on ("re-running the SAME committed cut returns
// committed=false") FAILED because the live-box gate made the cut genuinely different each time.
//
// The fix makes the committed cut a PURE function of (stable bounds, camera, intent, options):
// the hierarchy's geometry columns are seeded from the runtime's STABLE, layout-independent
// proxy bounds ONLY, and every geometry consumer (gate, solver, eviction) reads those. The live
// `boxes` input is no longer consumed by the cut at all.
//
// This test PROVES the loop cannot recur. It threads ONE persistent runtime across recuts (so
// the committed-generation chain is real), then:
//   (1) commits a cut at a coarse camera;
//   (2) recuts with the SAME runtime / snapshot / camera / vp / intent but WILDLY DIFFERENT
//       (perturbed — simulating a drifted Stress relayout) live `boxes`, repeatedly, and
//       asserts the committed selection is BYTE-IDENTICAL and `committed === false` every time
//       (no new generation — the canvas's scene-ready effect reaches a fixed point);
//   (3) asserts a genuine camera ZOOM-IN still refines further (committed === true, more reps),
//       so the decoupling did not break camera-driven refinement.

import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  acquireRepresentationRuntime,
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  type RepLodInput,
  type RepresentationRuntime,
} from "./lod-representation-cut";
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

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c — a directory tree deep enough that a zoom-in
// genuinely refines (coarse leaf-group proxies → finer file reps).
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/y/f3.c"),
    file("b/z/f4.c"),
    file("b/z/f5.c"),
    file("b/z/f6.c"),
    file("top.c"),
  ],
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

// A coarse camera where the cut commits a 3-rep leaf-group antichain, and a zoomed-in camera
// where it refines to a 5-rep finer antichain (verified against the stable layout constants).
const COARSE: Camera = { x: 0, y: 0, scale: 0.054 };
const ZOOMED_IN: Camera = { x: 0, y: 0, scale: 0.5 };

/**
 * A drifted Stress/Smart relayout: every group's live cluster box is at a WILDLY different
 * position and size each frame (`seed`-parametrized). This is exactly the non-deterministic,
 * never-converging geometry that drove the old loop — the cut must be totally indifferent to it.
 */
const driftBoxes = (seed: number): Map<string, Box> => {
  const m = new Map<string, Box>();
  for (const k of ["a", "a/x", "a/y", "b", "b/z"]) {
    m.set(k, {
      x: seed * 1000,
      y: -seed * 777,
      w: 100 + seed * 5000,
      h: 50 + seed * 3000,
    });
  }
  return m;
};

function recut(
  runtime: RepresentationRuntime,
  cam: Camera,
  boxes: Map<string, Box>,
  intent: CollapseIntent = noIntent,
) {
  const input: RepLodInput = {
    snapshot: snap,
    nodeIds,
    boxes,
    cam,
    vp,
    intent,
    options: opts,
    runtime,
  };
  return buildSceneRepresentationCut(input);
}

describe("rep cut is loop-proof: committed selection ignores drifting live boxes", () => {
  test("recut with the SAME camera but DRIFTED boxes is idempotent (committed=false, identical cut)", () => {
    // ONE persistent runtime threaded across every recut, so the committed-generation chain is
    // real (acquire reuses it on a matching material signature).
    const runtime = acquireRepresentationRuntime({
      snapshot: snap,
      nodeIds,
      boxes: driftBoxes(0),
      cam: COARSE,
      vp,
      intent: noIntent,
      options: opts,
    });

    // 1. First solve commits the coarse cut (the initial generation).
    const first = recut(runtime, COARSE, driftBoxes(1));
    expect(first.committed).toBe(true);
    const committedReps = [...first.cut.selectedRepresentations];
    expect(committedReps.length).toBeGreaterThan(0);

    // 2. Recut MANY times with the SAME runtime / snapshot / camera / vp / intent but WILDLY
    //    perturbed live boxes (each `seed` is a fresh "drifted Stress relayout"). The committed
    //    selection must be byte-identical and NO new generation may fire — otherwise the canvas
    //    scene-ready effect would recut again and the loop would recur.
    for (const seed of [2, 3, 17, 99, -5, 1000]) {
      const again = recut(runtime, COARSE, driftBoxes(seed));
      expect(again.committed).toBe(false); // no new generation → the loop terminates
      expect([...again.cut.selectedRepresentations]).toEqual(committedReps); // identical cut
      // The open/collapsed projections the render path consumes are stable too.
      expect([...again.openSelection].sort()).toEqual([...first.openSelection].sort());
      expect([...again.collapsedBoxKeys].sort()).toEqual([...first.collapsedBoxKeys].sort());
    }
  });

  test("a genuine camera ZOOM-IN still refines further (committed=true, MORE reps)", () => {
    const runtime = acquireRepresentationRuntime({
      snapshot: snap,
      nodeIds,
      boxes: driftBoxes(0),
      cam: COARSE,
      vp,
      intent: noIntent,
      options: opts,
    });

    const coarse = recut(runtime, COARSE, driftBoxes(1));
    expect(coarse.committed).toBe(true);
    const coarseCount = coarse.cut.selectedRepresentations.length;

    // Drift the boxes AND zoom in on the same runtime. The drift alone must not refine (proven
    // above); the ZOOM must — refinement is driven purely by the stable screen height past openPx.
    const zoomed = recut(runtime, ZOOMED_IN, driftBoxes(50));
    expect(zoomed.committed).toBe(true); // a materially-different (finer) cut → new generation
    expect(zoomed.cut.selectedRepresentations.length).toBeGreaterThan(coarseCount);

    // And the refined cut is itself a fixed point: recutting it with yet more drift is idempotent.
    const settled = recut(runtime, ZOOMED_IN, driftBoxes(-200));
    expect(settled.committed).toBe(false);
    expect([...settled.cut.selectedRepresentations]).toEqual([
      ...zoomed.cut.selectedRepresentations,
    ]);
  });
});
