// CAMERA-IN-THE-LOOP CONVERGENCE (the hard acceptance gate for the collapse↔refine fix).
//
// The prior convergence test (lod-recut-idempotent / calibration) holds the CAMERA FIXED and
// proves a recut at the same camera is idempotent. That can NOT catch the limit cycle this fix
// targets, because the cycle is driven by the CAMERA MOVING: the canvas fits the camera to the
// committed scene, the new scale changes which proxies clear openPx, that commits a different
// cut, whose scene has a different extent, which refits the camera again… A fixed-camera test
// never exercises that feedback edge.
//
// This test closes the loop. Each iteration:
//   1. buildSceneRepresentationCut with the current camera.
//   2. Take the COMMITTED cut's selected reps, read their CALIBRATED stable boxes (exactly the
//      geometry the materializer renders and the renderer fits to), and compute the scene's
//      world EXTENT (max width/height of the union bbox).
//   3. Set cam.scale = viewport / extent — a camera FIT to the committed scene (what the canvas
//      refit effect would do if it fired). cam.x/y are set so the scene is centred.
//   4. Recut with that camera. Repeat.
//
// The assertion: the committed CARD COUNT converges to a stable value within ≤4 iterations and
// stays put for 8 more — it does NOT oscillate between ~1 (the super-root collapse) and ~hundreds
// (the full refine). Before the calibration fix this loop is exactly the swing the telemetry
// recorded (1,405,1,216,1,…); with calibration the camera-fit scale lands the proxies at a stable
// projected size, so the gate's verdict is the same every iteration and the count is a fixed point.
//
// Control: refinement still TRACKS the camera. A genuine zoom-IN (a smaller viewed extent / larger
// scale than the fit) must yield MORE cards; a genuine zoom-OUT (larger extent / smaller scale)
// must yield FEWER. The fix must damp the camera-driven OSCILLATION without deafening the gate to
// real user zoom — otherwise it would have "fixed" the cycle by making LOD inert.

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

// A deep, wide directory tree — many top-level groups, each with several subdirs and a handful of
// files apiece. This is the shape that starts COARSE (the bootstrap cut shows a few top cards) and
// has real depth to refine through, so the camera-in-the-loop feedback edge is actually exercised
// (a flat 12-node graph barely moves the cut). ~12 top dirs × ~5 subdirs × ~10 files ≈ 600 nodes.
function bigGraph(): GraphModel {
  const nodes = [];
  for (let top = 0; top < 12; top++) {
    for (let sub = 0; sub < 5; sub++) {
      for (let f = 0; f < 10; f++) {
        nodes.push(file(`top${top}/sub${sub}/file${f}.c`));
      }
    }
  }
  return { nodes, edges: [] };
}

const graph = bigGraph();
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

const vp: Viewport = { w: 1600, h: 1000 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 240, maxCards: 800, nodeBudget: 1500 };
const noBoxes = (): Map<string, Box> => new Map<string, Box>();

function freshRuntime(liveExtent: number): RepresentationRuntime {
  return acquireRepresentationRuntime({
    snapshot: snap,
    nodeIds,
    boxes: noBoxes(),
    liveExtent,
    cam: { x: 0, y: 0, scale: 0.05 },
    vp,
    intent: noIntent,
    options: opts,
  });
}

function recut(runtime: RepresentationRuntime, cam: Camera, liveExtent?: number): RepLodResult {
  const input: RepLodInput = {
    snapshot: snap,
    nodeIds,
    boxes: noBoxes(),
    liveExtent,
    cam,
    vp,
    intent: noIntent,
    options: opts,
    runtime,
  };
  return buildSceneRepresentationCut(input);
}

/**
 * The committed scene's world EXTENT and centre, computed from the SELECTED reps' CALIBRATED
 * stable boxes — exactly the geometry the materializer renders for this cut and the camera fits to.
 * `boundsScale` is the pinned calibration factor on the result (so this matches the gate's world).
 */
function committedSceneExtent(result: RepLodResult): {
  extent: number;
  cx: number;
  cy: number;
} {
  const sb = result.repRuntime.stableBounds;
  const s = result.boundsScale;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rep of result.cut.selectedRepresentations) {
    const x = sb.x[rep] * s;
    const y = sb.y[rep] * s;
    const w = sb.w[rep] * s;
    const hh = sb.h[rep] * s;
    if (w <= 0 || hh <= 0) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + hh > maxY) maxY = y + hh;
  }
  if (maxX <= minX || maxY <= minY) {
    return { extent: 0, cx: 0, cy: 0 };
  }
  return {
    extent: Math.max(maxX - minX, maxY - minY),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

/** A camera FIT to a scene of the given extent/centre at the given viewport (what vc.fit() does). */
function fitCamera(extent: number, cx: number, cy: number): Camera {
  const scale = extent > 0 ? Math.min(vp.w, vp.h) / extent : 0.05;
  // Centre the scene: screen = world*scale + cam, so cam = viewportCentre − worldCentre*scale.
  return { x: vp.w / 2 - cx * scale, y: vp.h / 2 - cy * scale, scale };
}

describe("camera-in-the-loop: the committed card count is a fixed point, not a limit cycle", () => {
  test("a camera fit to the committed scene each iteration CONVERGES within ≤4 and holds for 8 more", () => {
    const liveExtent = 24_000; // a few-thousand-unit cloud; cam fits to ~0.05 initially
    const runtime = freshRuntime(liveExtent);

    // Iteration 0: the bootstrap/first cut at the initial fitted camera.
    let cam: Camera = { x: 0, y: 0, scale: Math.min(vp.w, vp.h) / liveExtent };
    const counts: number[] = [];

    for (let i = 0; i < 12; i++) {
      const r = recut(runtime, cam, i === 0 ? liveExtent : undefined);
      counts.push(r.cut.selectedRepresentations.length);
      // Fit the camera to THIS committed scene — the feedback edge that drove the limit cycle.
      const { extent, cx, cy } = committedSceneExtent(r);
      cam = fitCamera(extent, cx, cy);
    }

    // (a) NO collapse to the super-root: the cut is never the degenerate 1-card scene that the
    //     camera then refit to a speck (the trigger half of the cycle).
    for (const c of counts) {
      expect(c).toBeGreaterThan(1);
    }

    // (b) CONVERGENCE: by iteration 4 the count has reached its fixed point and never moves again.
    const tail = counts.slice(4); // iterations 4..11 — eight settled iterations
    const settled = tail[0];
    for (const c of tail) {
      expect(c).toBe(settled);
    }

    // (c) NOT an oscillation: the whole series has a SMALL spread (a limit cycle between ~1 and
    //     ~hundreds would span hundreds). Allow a tiny early transient before the fixed point.
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    expect(hi - lo).toBeLessThanOrEqual(Math.max(4, Math.ceil(settled * 0.25)));
  });

  test("CONTROL: the GATE still tracks the camera — zoom-IN yields more cards, zoom-OUT fewer", () => {
    // This control proves the fix damped the camera-driven OSCILLATION without deafening the refine
    // GATE to real user zoom. It probes the gate STATELESSLY — a fresh runtime per camera, so there
    // is no prior committed cut (no hysteresis retain) and no eviction retention carrying opens
    // forward. That isolates the gate's intrinsic response: `screenHeight(calibratedBox, scale)` vs
    // `openPx`. (The stateful production policy additionally RETAINS opened regions across a
    // zoom-out — "once opened, stays open" per the canvas decideRecut policy — which is a separate,
    // deliberate layer on TOP of the gate and is exactly why the closed loop above is a fixed point.
    // The property the fix must preserve is that the GATE itself still responds to scale.)
    const liveExtent = 24_000;
    const fitScale = Math.min(vp.w, vp.h) / liveExtent; // the camera-fit scale (≈ 0.0417)
    // Centre the calibrated world (the full 4096×boundsScale canvas) on the viewport, so a zoom-IN
    // magnifies the SAME centred content rather than pushing it off-screen — measuring the gate's
    // refine response, not a viewport-cull artefact. (Zooming in past ~2× eventually culls the
    // outer groups and the on-screen count falls again — correct, but not what this control probes.)
    const worldCentre = (PROXY_WORLD_SIZE * (liveExtent / PROXY_WORLD_SIZE)) / 2;
    const cam = (scale: number): Camera => ({
      x: vp.w / 2 - worldCentre * scale,
      y: vp.h / 2 - worldCentre * scale,
      scale,
    });
    const cardsAt = (scale: number): number => {
      const runtime = freshRuntime(liveExtent); // fresh → no retain state, pure gate
      return recut(runtime, cam(scale), liveExtent).cut.selectedRepresentations.length;
    };

    const atFit = cardsAt(fitScale);
    const zoomedIn = cardsAt(fitScale * 2); // user magnified → boxes project bigger → MORE refine
    const zoomedOut = cardsAt(fitScale / 2); // user pulled back → boxes project smaller → COARSER

    // Zoom-IN refines past the fit; zoom-OUT coarsens below it. The gate is neither pinned (the
    // oscillation "fix" of making LOD inert) nor inverted.
    expect(zoomedIn).toBeGreaterThan(atFit);
    expect(zoomedOut).toBeLessThan(atFit);
    // And the coarse end is strictly coarser than the fine end — a monotone response to the camera.
    expect(zoomedOut).toBeLessThan(zoomedIn);
  });
});
