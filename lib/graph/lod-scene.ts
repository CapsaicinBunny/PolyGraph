// Bridge between the live rendered Scene and the adaptive cut. Two pure helpers:
//
// 1. sceneBoxes(scene) — the world-space box of every directory currently on
//    screen, taken straight from what the renderer is drawing: open directories
//    are ClusterBoxes; collapsed directories are their aggregate card. Feeding
//    THESE boxes to computeCut keeps the cut decision in the renderer's exact
//    coordinate space, so "this dir looks big enough to open" means the same
//    thing the user sees — and it reuses the existing collapse→reflow path
//    (manual expand/collapse already works this way) rather than a parallel
//    layout. Directories not currently materialized have no box; computeCut
//    treats a missing box as "collapse", which is the safe default.
//
// 2. cameraBand(scale) — quantize zoom into ~1.5x bands so the cut only
//    recomputes when the zoom band changes, never every animation frame.

import { clusterIdOfAggregate, isAggregateId } from "./collapse";
import type { Box } from "./lod-screen";
import type { Scene } from "./scene";

/** World-space box per directory currently in the scene (open boxes + collapsed cards). */
export function sceneBoxes(scene: Scene): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const c of scene.clusters) {
    boxes.set(c.id, { x: c.x, y: c.y, w: c.width, h: c.height });
  }
  for (const n of scene.nodes) {
    if (isAggregateId(n.id)) {
      boxes.set(clusterIdOfAggregate(n.id), { x: n.x, y: n.y, w: n.width, h: n.height });
    }
  }
  return boxes;
}

/** Each integer band spans a ~1.5x zoom range — the recompute granularity. */
const BAND_BASE = 1.5;

/** Quantize a camera scale into a discrete LOD band (recompute only on change). */
export function cameraBand(scale: number): number {
  return Math.round(Math.log(Math.max(scale, 1e-6)) / Math.log(BAND_BASE));
}

/**
 * Whether the renderer should re-fit (re-frame) the camera on a scene change.
 * A `fitSignature` captures everything that warrants re-framing (new graph,
 * level, filters) but NOT the adaptive cut — so when only the cut changed the
 * camera is preserved. `undefined` (adaptive LOD off) always fits: today's
 * behavior, unchanged.
 */
export function shouldFit(fitSignature: string | undefined, prev: string | undefined): boolean {
  return fitSignature === undefined || fitSignature !== prev;
}
