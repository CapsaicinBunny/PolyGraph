// Pure screen-space projection for adaptive LOD. Uses the EXACT convention the
// Vello renderer uses (`screen = world * scale + cam`, see vello-renderer/src/lib.rs
// edge/cluster transforms and lib/graph/frame.ts), so a directory box the cut
// decides is "too small to open" is the same size the renderer would draw. No DOM,
// no GPU — just arithmetic, so it's fully unit-testable.

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/** World-space box: top-left origin + size (matches layout's ClusterBox). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Project a world box to screen pixels: `screen = world * scale + cam`. */
export function worldToScreen(box: Box, cam: Camera): ScreenRect {
  const left = box.x * cam.scale + cam.x;
  const top = box.y * cam.scale + cam.y;
  return {
    left,
    top,
    right: left + box.w * cam.scale,
    bottom: top + box.h * cam.scale,
  };
}

/** On-screen pixel height of a box — the screen-space-error proxy the cut uses. */
export function screenHeight(box: Box, scale: number): number {
  return box.h * scale;
}

/**
 * Does the screen rect intersect the `margin`-padded viewport? Mirrors the
 * renderer's `on_screen` cull so the cut and the renderer agree on visibility.
 */
export function intersectsViewport(rect: ScreenRect, vp: Viewport, margin = 0): boolean {
  return (
    rect.right >= -margin &&
    rect.left <= vp.w + margin &&
    rect.bottom >= -margin &&
    rect.top <= vp.h + margin
  );
}
