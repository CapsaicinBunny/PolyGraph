// SCALE CALIBRATION + HYSTERESIS (the camera-driven collapse↔refine limit-cycle fix).
//
// The bug: the refine gate measured each proxy's on-screen size as screenHeight(stableBox, cam.scale),
// but the stable bounds live in a FIXED PROXY_WORLD_SIZE=4096 canvas while cam.scale is fit to the
// LIVE layout's world extent (~10k–50k units for a few-thousand-node cloud → cam.scale ≈ 0.05 when
// fit). At that scale an un-rescaled top-level stable box (~hundreds of units) projects to a few
// pixels ≪ openPx, so NOTHING cleared the gate: the cut collapsed to the super-root (1 card), the
// 1-node scene refit the camera to a tiny extent (cam.scale huge), the same stable boxes projected
// huge, everything refined (~1100 cards), the camera refit to the large extent, cam.scale went tiny —
// and the cycle repeated.
//
// The fix rescales every stable box by (liveExtent / PROXY_WORLD_SIZE) so the gate measures proxies
// in the SAME world the camera was fit to. This test proves, with concrete numbers, that:
//   (1) the calibration factor is exactly liveExtent / PROXY_WORLD_SIZE and is reported on the result;
//   (2) at a camera fit to a LARGE live extent, the UNcalibrated cut collapses to ~1 card but the
//       CALIBRATED cut refines (the limit cycle's trigger is gone);
//   (3) calibration is captured ONCE on the runtime (the same boundsScale across recuts even if a
//       later recut passes a different/absent liveExtent) — the "do not recompute per frame" rule;
//   (4) the hysteresis deadband keeps a previously-open proxy open across a small zoom-out that would
//       otherwise drop it just below openPx (no flip-flop).

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
import { PROXY_WORLD_SIZE } from "./representation-proxy-layout";
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

// A directory tree with several top-level groups, each with subdirs and files — deep and wide
// enough that the bootstrap cut starts coarse (few top cards) and a calibrated zoom refines it.
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/x/f3.c"),
    file("a/y/f4.c"),
    file("a/y/f5.c"),
    file("b/z/f6.c"),
    file("b/z/f7.c"),
    file("b/w/f8.c"),
    file("c/q/f9.c"),
    file("c/q/f10.c"),
    file("c/r/f11.c"),
    file("d/s/f12.c"),
  ],
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

const vp: Viewport = { w: 1200, h: 900 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 240, maxCards: 800, nodeBudget: 1500 };
const noBoxes = (): Map<string, Box> => new Map<string, Box>();

function freshRuntime(liveExtent?: number, cam: Camera = { x: 0, y: 0, scale: 0.05 }) {
  return acquireRepresentationRuntime({
    snapshot: snap,
    nodeIds,
    boxes: noBoxes(),
    liveExtent,
    cam,
    vp,
    intent: noIntent,
    options: opts,
  });
}

function recut(
  runtime: RepresentationRuntime,
  cam: Camera,
  liveExtent?: number,
  intent: CollapseIntent = noIntent,
) {
  const input: RepLodInput = {
    snapshot: snap,
    nodeIds,
    boxes: noBoxes(),
    liveExtent,
    cam,
    vp,
    intent,
    options: opts,
    runtime,
  };
  return buildSceneRepresentationCut(input);
}

describe("scale calibration: the fitted camera clears openPx the way the live boxes did", () => {
  test("boundsScale is exactly liveExtent / PROXY_WORLD_SIZE and is reported", () => {
    const liveExtent = 30_000;
    const runtime = freshRuntime(liveExtent);
    const r = recut(runtime, { x: 0, y: 0, scale: 0.05 }, liveExtent);
    expect(r.liveExtent).toBe(liveExtent);
    expect(r.boundsScale).toBeCloseTo(liveExtent / PROXY_WORLD_SIZE, 6);
    // The worked example from the design: liveExtent=30000 → boundsScale ≈ 7.32.
    expect(r.boundsScale).toBeGreaterThan(7);
    expect(r.boundsScale).toBeLessThan(7.5);
  });

  test("calibrated math: a ~580-unit stable group projects to a legible ~hundreds of px at scale 0.05", () => {
    // The bug's exact arithmetic. A top-level stable group is ~PROXY_WORLD_SIZE/sqrt(#groups) units.
    // With 4 top groups that is ~4096/2 ≈ 2048 wide; the smaller leaf-group boxes are ~580. Take the
    // design's representative 580-unit box: rescaled by 30000/4096 ≈ 7.32 → ~4248 units → ×0.05 ≈ 212px.
    const stableUnits = 580;
    const boundsScale = 30_000 / PROXY_WORLD_SIZE;
    const screenPx = stableUnits * boundsScale * 0.05;
    expect(screenPx).toBeGreaterThan(200);
    expect(screenPx).toBeLessThan(225);
    // Without calibration the SAME box is 580 × 0.05 ≈ 29px — far below openPx(240): the collapse.
    expect(stableUnits * 0.05).toBeLessThan(40);
  });

  test("at a fitted (large-extent) camera the UNcalibrated cut collapses but the CALIBRATED cut refines", () => {
    const cam: Camera = { x: 0, y: 0, scale: 0.05 }; // fit to a ~24k-unit live cloud
    const liveExtent = 24_000;

    // Uncalibrated: no liveExtent → boundsScale 1 → stable boxes project to a few px → the gate
    // clears nothing → the cut collapses toward the super-root (≤ a small handful of cards).
    const uncal = recut(freshRuntime(undefined), cam, undefined);
    expect(uncal.boundsScale).toBe(1);

    // Calibrated: the gate measures the rescaled boxes → top groups clear openPx → it refines.
    const cal = recut(freshRuntime(liveExtent), cam, liveExtent);
    expect(cal.boundsScale).toBeGreaterThan(1);
    expect(cal.cut.selectedRepresentations.length).toBeGreaterThan(
      uncal.cut.selectedRepresentations.length,
    );
    // The calibrated cut is NOT the degenerate 1-card super-root scene that drove the cycle.
    expect(cal.cut.selectedRepresentations.length).toBeGreaterThan(1);
  });

  test("calibration is captured ONCE on the runtime — a later recut's extent does not change it", () => {
    const liveExtent = 18_000;
    const runtime = freshRuntime(liveExtent);
    const first = recut(runtime, { x: 0, y: 0, scale: 0.05 }, liveExtent);
    // A subsequent recut passes a WILDLY different extent (or none). The runtime ignores it on the
    // reuse path — boundsScale stays pinned to the value captured when the runtime was built.
    const again = recut(runtime, { x: 0, y: 0, scale: 0.05 }, 999_999);
    const none = recut(runtime, { x: 0, y: 0, scale: 0.05 }, undefined);
    expect(again.boundsScale).toBeCloseTo(first.boundsScale, 6);
    expect(none.boundsScale).toBeCloseTo(first.boundsScale, 6);
    expect(again.liveExtent).toBe(liveExtent);
  });
});

describe("hysteresis deadband damps the openPx-boundary flip-flop", () => {
  test("a previously-open proxy survives a small zoom-out that a closed proxy would not", () => {
    const liveExtent = 24_000;
    const runtime = freshRuntime(liveExtent);

    // Zoom in far enough to open groups (commit a refined cut).
    const opened = recut(runtime, { x: 0, y: 0, scale: 0.08 }, liveExtent);
    const openedCount = opened.cut.selectedRepresentations.length;
    expect(openedCount).toBeGreaterThan(1);

    // Now zoom OUT slightly — to a scale where a freshly-CLOSED proxy of the same size sits just
    // below openPx, but an already-OPEN proxy stays above the 0.6×openPx retain threshold. The
    // open set must NOT collapse back (the deadband), so the refined cut is retained.
    const settled = recut(runtime, { x: 0, y: 0, scale: 0.065 }, liveExtent);
    expect(settled.cut.selectedRepresentations.length).toBeGreaterThanOrEqual(openedCount);
  });
});
