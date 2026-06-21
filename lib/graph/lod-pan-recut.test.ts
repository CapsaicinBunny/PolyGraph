// Gap 8 — the pan-end visibility + eviction recut.
//
// recomputeCut used to be scheduled ONLY from the wheel handler, and the camera-band guard
// rejected any recompute unless the zoom band INCREASED. So panning an open region off-screen
// at the SAME zoom never updated retention / eviction: the LRU was frozen between zooms.
//
// The fix runs a pan-end recut in VISIBILITY mode — same camera SCALE (so the same band, the
// case the old guard dropped), updating the eviction LRU WITHOUT advancing the refined band /
// forcing deeper refinement. This test drives the underlying engine through a persistent
// runtime to prove that a same-scale recut after a pan does update retention + eviction.

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
import { cameraBand } from "./lod-scene";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// Three top groups (a, b, c), each with files, spread far apart in world space so a pan can
// move one off-screen while the others stay put.
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("b/y/f3.c"),
    file("b/y/f4.c"),
    file("c/z/f5.c"),
    file("c/z/f6.c"),
  ],
  edges: [makeEdge("a/x/f1.c", "b/y/f3.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const vp: Viewport = { w: 800, h: 600 };

// Big, on-screen-when-centered boxes so each group auto-refines when the camera is over it.
const allBoxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 2000, h: 2000 }],
    ["a/x", { x: 0, y: 0, w: 2000, h: 2000 }],
    ["b", { x: 100_000, y: 0, w: 2000, h: 2000 }],
    ["b/y", { x: 100_000, y: 0, w: 2000, h: 2000 }],
    ["c", { x: 200_000, y: 0, w: 2000, h: 2000 }],
    ["c/z", { x: 200_000, y: 0, w: 2000, h: 2000 }],
  ]);

const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 80, maxCards: 800, nodeBudget: 2500 };

// A camera centered on a given world point at scale 1 (so the band is the same throughout —
// this is the "pan, no zoom" path the old band guard rejected).
const camAt = (worldX: number): Camera =>
  ({ x: vp.w / 2 - worldX, y: vp.h / 2, scale: 1 }) as Camera;

// The signature inputs the canvas threads through BOTH acquire and build. Acquiring with the
// SAME inputs the build uses is what keeps the runtime (and its eviction controller) reused
// across recuts instead of being rebuilt with a fresh, empty LRU.
const baseInput = (cam: Camera): RepLodInput => ({
  snapshot: snap,
  nodeIds,
  boxes: allBoxes(),
  cam,
  vp,
  intent: new Map() as CollapseIntent,
  options: opts,
  filteredGraphId: "g",
  groupingVersion: 0,
  nodeCostSignature: "",
});

/** Build the initial persistent runtime exactly as the canvas would (matched signature). */
const initialRuntime = (offscreenBudget: number): RepresentationRuntime =>
  acquireRepresentationRuntime(baseInput(camAt(1000)), undefined, offscreenBudget);

/**
 * One recut against the persistent runtime, mirroring the canvas's reuse path: re-acquire
 * (reused verbatim when the material signature is unchanged — a pure camera move), then build.
 */
const recut = (
  runtime: RepresentationRuntime,
  cam: Camera,
  offscreenBudget: number,
): RepresentationRuntime => {
  const input = baseInput(cam);
  const reacquired = acquireRepresentationRuntime(input, runtime, offscreenBudget);
  buildSceneRepresentationCut({ ...input, runtime: reacquired });
  return reacquired;
};

describe("pan-end recut updates retention + eviction at the SAME zoom band (Gap 8)", () => {
  test("a pan keeps the same band — the old wheel/band-increase guard would never recut", () => {
    // Sanity: panning across the world at a fixed scale never changes the camera band, so the
    // old `band <= lodBand.current` guard (zoom-only) would reject every pan recut.
    const bandA = cameraBand(camAt(1000).scale);
    const bandB = cameraBand(camAt(100_000).scale);
    expect(bandA).toBe(bandB);
  });

  test("an opened region pans off-screen but is RETAINED (deadband), tracked by the LRU", () => {
    // Generous offscreen budget: the deadband holds the opened region after it leaves view.
    let runtime = initialRuntime(64);
    const aRep = runtime.hierarchy.repOfGroup[0]; // the rep for group 'a'

    // Frame 1 — centered on 'a': it auto-opens on-screen and the LRU tracks it.
    runtime = recut(runtime, camAt(1000), 64);
    expect(runtime.eviction.retained()).toContain(aRep);

    // Frame 2 — PAN far away to 'c' (same scale → same band). The pan-end visibility recut
    // must run (the engine is band-agnostic; the canvas guard is what changed) and still
    // RETAIN 'a' in the deadband, not silently drop it.
    runtime = recut(runtime, camAt(200_000), 64);
    expect(runtime.eviction.retained()).toContain(aRep);
    // No eviction yet — the budget (64) is far above the tracked set.
    expect(runtime.eviction.totalEvictions).toBe(0);
  });

  test("over the offscreen budget, a same-band pan EVICTS the oldest open region (LRU)", () => {
    // Budget of 1: only one offscreen auto-open may be retained — exploring a second region
    // by panning must evict the first via the LRU. This is exactly the retention/eviction
    // update the old zoom-only guard never performed on a pan.
    let runtime = initialRuntime(1);

    runtime = recut(runtime, camAt(1000), 1); // open 'a' (on screen)
    runtime = recut(runtime, camAt(100_000), 1); // pan to 'b': 'a' offscreen, 'b' opens — over budget
    // The pan recut evicted the oldest offscreen auto-open ('a') down to the budget of 1.
    expect(runtime.eviction.totalEvictions).toBeGreaterThan(0);
    expect(runtime.eviction.trackedSize).toBeLessThanOrEqual(1);
  });
});
