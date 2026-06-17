import { expect, test } from "bun:test";
import { frameBoxes } from "./frame";

test("returns null for no boxes or empty viewport", () => {
  expect(frameBoxes([], 800, 600)).toBeNull();
  expect(frameBoxes([{ x: 0, y: 0, width: 10, height: 10 }], 0, 600)).toBeNull();
});

test("centers a single small box and clamps to maxScale", () => {
  const cam = frameBoxes([{ x: 100, y: 100, width: 170, height: 44 }], 800, 600)!;
  expect(cam.scale).toBeCloseTo(1.2, 5); // clamped, not zoomed to fit
  // box center (185,122) maps to viewport center (400,300): cx = 400 - 185*scale
  expect(cam.x).toBeCloseTo(400 - 185 * 1.2, 3);
  expect(cam.y).toBeCloseTo(300 - 122 * 1.2, 3);
});

test("scales down to fit a large bounding box within padding", () => {
  const cam = frameBoxes([{ x: 0, y: 0, width: 4000, height: 200 }], 800, 600)!;
  // width-limited: (800 - 160) / 4000 = 0.16
  expect(cam.scale).toBeCloseTo(0.16, 5);
});
