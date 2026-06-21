// ACCEPTANCE GATE for the recut-loop fix ("constantly cutting" / camera zooms to max /
// "Laying out…" never clears — Smart/Stress/Backbone worst). This test PROVES the loop is
// dead at the cut level by SIMULATING THE CANVAS'S AUTONOMOUS RE-ENTRY CYCLE:
//
//   recompute → committed cut bumps generation → canvas writes a new cutSignature →
//   useScene relayouts → a NEW `scene` object → the scene-ready effect fires recomputeCut →
//   recompute → …
//
// The canvas threads ONE persistent runtime across that cycle (a ref), feeding each result's
// `repRuntime` back into the next `buildSceneRepresentationCut`. We reproduce exactly that:
// call the cut REPEATEDLY with the SAME persistent runtime + SAME snapshot + SAME camera / vp /
// intent + SAME (or perturbed, simulating a drifted Stress relayout) boxes, feeding the runtime
// forward each time, and assert it reaches a FIXED POINT — `committed` becomes false within
// <= 3 iterations and STAYS false for 10 more (no infinite commit / generation bump).
//
// Two distinct loop sources are covered:
//   (1) the live-box / generation re-entry edge (the headline fix: the cut is a pure function
//       of stable bounds + camera + intent, so a relayout of the same committed cut is a no-op);
//   (2) the STATEFUL eviction/retention re-solve — the residual loop. When more group proxies
//       are auto-opened ON-SCREEN than the offscreen-open budget, the OLD controller evicted
//       on-screen reps with an LRU recency tiebreak that picked a different victim each frame,
//       so the re-solved cut oscillated (a period-N limit cycle) and `committed` never settled.
//       The fix exempts on-screen opens from the budget; the small-budget cases below would have
//       oscillated forever before it and now converge.
//
// CONTROL assertions (the decoupling must NOT have broken legitimate recuts):
//   • a genuine camera ZOOM-IN still yields committed=true (refinement still works);
//   • a genuine intent change (forceOpen a group) still commits.

import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  acquireRepresentationRuntime,
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  type RepLodInput,
  type RepLodResult,
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

// A directory tree deep enough that a zoom-in genuinely refines and several intermediate
// zooms auto-open multiple group proxies at once (so eviction/retention is exercised).
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
const groupIds = snap.groupIds; // ["directory:a","directory:a/x","directory:a/y","directory:b","directory:b/z"]

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

// Live boxes are deliberately IRRELEVANT to the cut (it reads stable bounds only). We pass an
// empty map for the stable cases and perturb it for the drift case to prove indifference.
const noBoxes = (): Map<string, Box> => new Map();
const driftBoxes = (seed: number): Map<string, Box> => {
  const m = new Map<string, Box>();
  for (const k of ["a", "a/x", "a/y", "b", "b/z"]) {
    m.set(k, { x: seed * 1000, y: -seed * 777, w: 100 + seed * 5000, h: 50 + seed * 3000 });
  }
  return m;
};

function recut(
  runtime: RepresentationRuntime,
  cam: Camera,
  boxes: Map<string, Box>,
  intent: CollapseIntent = noIntent,
): RepLodResult {
  const input: RepLodInput = { snapshot: snap, nodeIds, boxes, cam, vp, intent, options: opts, runtime };
  return buildSceneRepresentationCut(input);
}

function freshRuntime(cam: Camera, offscreenBudget?: number): RepresentationRuntime {
  return acquireRepresentationRuntime(
    { snapshot: snap, nodeIds, boxes: noBoxes(), cam, vp, intent: noIntent, options: opts },
    undefined,
    offscreenBudget,
  );
}

/**
 * Drive the canvas's autonomous cycle: feed each result's runtime back in and recut with the
 * SAME inputs. Returns the iteration index at which `committed` first became false and the
 * sequence of committed selections, so the caller can assert the fixed point.
 */
function driveCycle(
  cam: Camera,
  boxesFor: (i: number) => Map<string, Box>,
  intent: CollapseIntent,
  runtime: RepresentationRuntime,
  iterations: number,
): { committedFlags: boolean[]; selections: number[][]; generations: number[] } {
  const committedFlags: boolean[] = [];
  const selections: number[][] = [];
  const generations: number[] = [];
  let rt = runtime;
  for (let i = 0; i < iterations; i++) {
    const r = recut(rt, cam, boxesFor(i), intent);
    rt = r.repRuntime; // feed the runtime forward, exactly as the canvas ref does
    committedFlags.push(r.committed);
    selections.push([...r.cut.selectedRepresentations].sort((p, q) => p - q));
    generations.push(r.runtime.generation);
  }
  return { committedFlags, selections, generations };
}

/** Assert: committed becomes false within <=3 iterations and STAYS false for the rest. */
function expectFixedPoint(flags: boolean[], selections: number[][], generations: number[]) {
  const settleAt = flags.indexOf(false);
  expect(settleAt).toBeGreaterThanOrEqual(0);
  expect(settleAt).toBeLessThanOrEqual(2); // <= 3 iterations (0-based index <= 2)
  // From the settle point on, no further commit and no generation bump (the loop is dead).
  const settledGen = generations[settleAt];
  for (let i = settleAt; i < flags.length; i++) {
    expect(flags[i]).toBe(false);
    expect(generations[i]).toBe(settledGen);
    expect(selections[i]).toEqual(selections[settleAt]); // byte-identical committed cut
  }
}

describe("recut convergence — the canvas's autonomous cycle reaches a FIXED POINT", () => {
  // A spread of cameras: a coarse one (bootstrap antichain, no auto-opens), and several
  // intermediate/deep zooms that auto-open multiple proxies on-screen at once (exercising the
  // eviction/retention re-solve — the residual-loop source).
  const cameras: Array<[string, Camera]> = [
    ["coarse (no auto-opens)", { x: 0, y: 0, scale: 0.054 }],
    ["mid zoom (5 on-screen auto-opens)", { x: 0, y: 0, scale: 0.12 }],
    ["zoom (3 auto-opens)", { x: 0, y: 0, scale: 0.3 }],
    ["deep zoom", { x: 0, y: 0, scale: 1.0 }],
  ];

  for (const [name, cam] of cameras) {
    test(`identical-input recuts converge within 3 and stay settled for 10 more — ${name}`, () => {
      const rt = freshRuntime(cam);
      const { committedFlags, selections, generations } = driveCycle(
        cam,
        () => noBoxes(),
        noIntent,
        rt,
        13, // 1st commit + settle within 3 + 10 more
      );
      // The very first solve commits the initial generation.
      expect(committedFlags[0]).toBe(true);
      expectFixedPoint(committedFlags, selections, generations);
    });
  }

  test("convergence is indifferent to DRIFTING live boxes (Stress/Smart non-determinism)", () => {
    const cam: Camera = { x: 0, y: 0, scale: 0.3 };
    const rt = freshRuntime(cam);
    // Each iteration feeds a wildly different live-box layout (a drifted Stress relayout). The
    // cut must ignore it entirely and still reach a fixed point.
    const { committedFlags, selections, generations } = driveCycle(
      cam,
      (i) => driftBoxes(i * 37 - 11),
      noIntent,
      rt,
      13,
    );
    expect(committedFlags[0]).toBe(true);
    expectFixedPoint(committedFlags, selections, generations);
  });

  // The RESIDUAL loop guard: a tiny offscreen-open budget forces the eviction/retention
  // re-solve to run hot. Before the on-screen-exemption fix this oscillated forever
  // (committed=true every frame, a different LRU victim each iteration). It must now converge.
  for (const [name, scale] of [
    ["mid zoom", 0.12],
    ["zoom", 0.3],
  ] as Array<[string, number]>) {
    test(`tiny offscreen budget does NOT prevent the fixed point — ${name}`, () => {
      const cam: Camera = { x: 0, y: 0, scale };
      const rt = freshRuntime(cam, 1); // budget 1 → eviction/retention runs every frame
      const { committedFlags, selections, generations } = driveCycle(
        cam,
        () => noBoxes(),
        noIntent,
        rt,
        13,
      );
      expect(committedFlags[0]).toBe(true);
      expectFixedPoint(committedFlags, selections, generations);
    });
  }

  test("an offscreen PAN settles too (eviction fires once, then a fixed point)", () => {
    const onScreen: Camera = { x: 0, y: 0, scale: 0.2 };
    const rt = freshRuntime(onScreen, 1);
    // Settle on-screen first.
    driveCycle(onScreen, () => noBoxes(), noIntent, rt, 3);
    // Pan the open region far off-screen and recut repeatedly. Eviction may fire on the camera
    // change, but the cycle must reach a fixed point within 3 and hold for 10 more.
    const panned: Camera = { x: -90_000, y: -90_000, scale: 0.2 };
    const { committedFlags, selections, generations } = driveCycle(
      panned,
      () => noBoxes(),
      noIntent,
      rt,
      13,
    );
    expectFixedPoint(committedFlags, selections, generations);
  });
});

describe("recut convergence — CONTROL: legitimate triggers still commit", () => {
  test("a genuine camera ZOOM-IN still refines (committed=true, MORE reps)", () => {
    const coarse: Camera = { x: 0, y: 0, scale: 0.054 };
    const rt = freshRuntime(coarse);

    // Settle at the coarse camera (fixed point).
    const coarseRun = driveCycle(coarse, () => noBoxes(), noIntent, rt, 4);
    const coarseReps = coarseRun.selections[coarseRun.selections.length - 1];
    expect(coarseRun.committedFlags[coarseRun.committedFlags.length - 1]).toBe(false);

    // Zoom in: a materially-finer cut MUST commit (refinement is alive), then settle again.
    const zoomedIn: Camera = { x: 0, y: 0, scale: 0.5 };
    const zoomRun = driveCycle(zoomedIn, () => noBoxes(), noIntent, rt, 13);
    expect(zoomRun.committedFlags[0]).toBe(true); // the zoom is a real, committing change
    expect(zoomRun.selections[0].length).toBeGreaterThan(coarseReps.length); // refined further
    // …and the refined cut is itself a fixed point (no residual loop after a real change).
    expectFixedPoint(zoomRun.committedFlags, zoomRun.selections, zoomRun.generations);
  });

  test("a genuine INTENT change (forceOpen a group) still commits, then settles", () => {
    const cam: Camera = { x: 0, y: 0, scale: 0.054 };
    const rt = freshRuntime(cam);

    // Settle at coarse with no intent.
    const base = driveCycle(cam, () => noBoxes(), noIntent, rt, 4);
    const baseReps = base.selections[base.selections.length - 1];
    expect(base.committedFlags[base.committedFlags.length - 1]).toBe(false);

    // Force a top-level group OPEN (the user expands it). This is a real material change → it
    // must commit, then the new state must itself converge.
    const intent: CollapseIntent = new Map([[groupIds[0], "open"]]);
    const openRun = driveCycle(cam, () => noBoxes(), intent, rt, 13);
    expect(openRun.committedFlags[0]).toBe(true); // the forced open is a real, committing change
    // The committed cut actually changed (a forced-open group refines into its children).
    expect(openRun.selections[0]).not.toEqual(baseReps);
    expectFixedPoint(openRun.committedFlags, openRun.selections, openRun.generations);
  });
});
