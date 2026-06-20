import { describe, expect, test } from "bun:test";
import { centerCameraOn, contentBounds, fitProjection, viewportWorldRect } from "./minimap";
import type { Scene } from "./scene";

function scene(
  nodes: { x: number; y: number; width: number; height: number }[],
  clusters: { x: number; y: number; width: number; height: number }[] = [],
): Scene {
  return {
    nodes: nodes.map((n, i) => ({ id: `n${i}`, ...n }) as Scene["nodes"][number]),
    edges: [],
    positions: new Map(),
    clusters: clusters.map(
      (c, i) => ({ id: `c${i}`, depth: 0, ...c }) as Scene["clusters"][number],
    ),
  };
}

describe("minimap geometry", () => {
  test("contentBounds covers nodes and clusters", () => {
    const b = contentBounds(
      scene([{ x: 10, y: 20, width: 30, height: 40 }], [{ x: 0, y: 0, width: 100, height: 5 }]),
    );
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 60 });
  });

  test("contentBounds is null for an empty scene", () => {
    expect(contentBounds(scene([]))).toBeNull();
  });

  test("viewportWorldRect inverts the camera convention", () => {
    // cam centers world (0,0) at screen (50,50) at scale 2 → world (50,50)=top-left.
    const r = viewportWorldRect({ x: -100, y: -100, scale: 2 }, 200, 100);
    expect(r).toEqual({ minX: 50, minY: 50, maxX: 150, maxY: 100 });
  });

  test("fitProjection round-trips and stays within the map", () => {
    const p = fitProjection({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 120, 4);
    const back = p.toWorld(...(Object.values(p.toMap(40, 25)) as [number, number]));
    expect(back.x).toBeCloseTo(40, 5);
    expect(back.y).toBeCloseTo(25, 5);
    // Corners land inside the padded map.
    const tl = p.toMap(0, 0);
    const br = p.toMap(100, 50);
    expect(tl.x).toBeGreaterThanOrEqual(3.99);
    expect(br.x).toBeLessThanOrEqual(196.01);
  });

  test("centerCameraOn puts the world point at viewport center", () => {
    const cam = centerCameraOn(200, 100, 2, 400, 300);
    // screen = world*scale + cam  → should equal viewport center (200,150).
    expect(200 * 2 + cam.x).toBeCloseTo(200, 5);
    expect(100 * 2 + cam.y).toBeCloseTo(150, 5);
  });
});
