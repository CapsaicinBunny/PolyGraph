// Pure geometry for the minimap overlay: the graph's world-space extent, the
// world rectangle the camera currently shows, and a fit-projection from world space
// into the small minimap canvas. Kept renderer-agnostic and unit-tested so the
// fiddly coordinate math is verified without a GPU.
//
// Camera convention matches the Vello renderer: screen = world * scale + (cam.x,
// cam.y), so the visible world rect is world = (screen - cam) / scale.

import type { Scene } from "./scene";

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** Bounding box over every node + cluster box in the scene. Null when empty. */
export function contentBounds(scene: Scene): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const cover = (x: number, y: number, w: number, h: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  };
  for (const n of scene.nodes) cover(n.x, n.y, n.width, n.height);
  for (const c of scene.clusters) cover(c.x, c.y, c.width, c.height);
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** The world-space rectangle currently visible for `cam` in a `vpW`x`vpH` viewport. */
export function viewportWorldRect(cam: Camera, vpW: number, vpH: number): Rect {
  const s = cam.scale || 1;
  const minX = -cam.x / s;
  const minY = -cam.y / s;
  return { minX, minY, maxX: minX + vpW / s, maxY: minY + vpH / s };
}

export interface Projection {
  /** Map a world point onto the minimap canvas. */
  toMap: (wx: number, wy: number) => { x: number; y: number };
  /** Map a minimap-canvas point back to world space. */
  toWorld: (mx: number, my: number) => { x: number; y: number };
  scale: number;
}

/**
 * Fit `bounds` into a `mapW`x`mapH` minimap with `pad` px of margin, preserving
 * aspect ratio and centering. Degenerate (zero-size) bounds get a unit scale.
 */
export function fitProjection(bounds: Rect, mapW: number, mapH: number, pad = 4): Projection {
  const bw = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const bh = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((mapW - 2 * pad) / bw, (mapH - 2 * pad) / bh);
  // Center the scaled content within the map.
  const offX = (mapW - bw * scale) / 2 - bounds.minX * scale;
  const offY = (mapH - bh * scale) / 2 - bounds.minY * scale;
  return {
    scale,
    toMap: (wx, wy) => ({ x: wx * scale + offX, y: wy * scale + offY }),
    toWorld: (mx, my) => ({ x: (mx - offX) / scale, y: (my - offY) / scale }),
  };
}

/**
 * Camera that centers the viewport on world point (wx, wy) at the current scale —
 * used when the user clicks the minimap to recenter. Inverse of the camera
 * convention: for the world point to land at viewport center, cam = vpCenter -
 * world*scale.
 */
export function centerCameraOn(
  wx: number,
  wy: number,
  scale: number,
  vpW: number,
  vpH: number,
): Camera {
  return { x: vpW / 2 - wx * scale, y: vpH / 2 - wy * scale, scale };
}
