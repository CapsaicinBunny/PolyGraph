// Pure camera math for framing a set of world-space rects in the viewport. Mirrors
// the Vello renderer's camera convention: screen = world * scale + (x, y).
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * Camera that frames `boxes` centered in a `vw`×`vh` viewport with `padding`, scaled
 * to fit but clamped to `[0.02, maxScale]` so a single small box doesn't zoom to max.
 * Returns null if there's nothing to frame or the viewport is empty.
 */
export function frameBoxes(
  boxes: FrameBox[],
  vw: number,
  vh: number,
  maxScale = 1.2,
  padding = 80,
): Camera | null {
  if (boxes.length === 0 || vw <= 0 || vh <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const fit = Math.min((vw - padding * 2) / w, (vh - padding * 2) / h, maxScale);
  const scale = Math.max(0.02, fit);
  return {
    x: vw / 2 - ((minX + maxX) / 2) * scale,
    y: vh / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
}
