import { describe, expect, test } from "bun:test";
import { type Box, intersectsViewport, screenHeight, worldToScreen } from "./lod-screen";

const box: Box = { x: 100, y: 200, w: 300, h: 400 };

describe("worldToScreen", () => {
  test("applies screen = world*scale + cam", () => {
    const r = worldToScreen(box, { x: 10, y: 20, scale: 2 });
    expect(r.left).toBe(100 * 2 + 10);
    expect(r.top).toBe(200 * 2 + 20);
    expect(r.right).toBe((100 + 300) * 2 + 10);
    expect(r.bottom).toBe((200 + 400) * 2 + 20);
  });

  test("identity camera is world coords", () => {
    expect(worldToScreen(box, { x: 0, y: 0, scale: 1 })).toEqual({
      left: 100,
      top: 200,
      right: 400,
      bottom: 600,
    });
  });
});

describe("screenHeight", () => {
  test("scales the box height", () => {
    expect(screenHeight(box, 0.5)).toBe(200);
    expect(screenHeight(box, 2)).toBe(800);
  });
});

describe("intersectsViewport", () => {
  const vp = { w: 800, h: 600 };
  test("inside the viewport", () => {
    expect(intersectsViewport({ left: 10, top: 10, right: 100, bottom: 100 }, vp)).toBe(true);
  });
  test("fully off the right / bottom", () => {
    expect(intersectsViewport({ left: 900, top: 10, right: 1000, bottom: 100 }, vp)).toBe(false);
    expect(intersectsViewport({ left: 10, top: 700, right: 100, bottom: 800 }, vp)).toBe(false);
  });
  test("fully off the left / top", () => {
    expect(intersectsViewport({ left: -200, top: 10, right: -10, bottom: 100 }, vp)).toBe(false);
    expect(intersectsViewport({ left: 10, top: -200, right: 100, bottom: -10 }, vp)).toBe(false);
  });
  test("touching the edge counts as visible", () => {
    expect(intersectsViewport({ left: 800, top: 0, right: 900, bottom: 100 }, vp)).toBe(true);
  });
  test("margin extends the test", () => {
    const rect = { left: 850, top: 10, right: 870, bottom: 100 };
    expect(intersectsViewport(rect, vp, 0)).toBe(false);
    expect(intersectsViewport(rect, vp, 100)).toBe(true);
  });
});
