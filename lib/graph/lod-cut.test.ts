import { describe, expect, test } from "bun:test";
import { buildDirTree } from "./hierarchy";
import { type Box } from "./lod-screen";
import { computeCut, type CutOptions, cutEquals } from "./lod-cut";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// dirs: a (a/x:f1,f2 ; a/y:f3), b (b/z:f4,f5)
const graph: GraphModel = {
  nodes: [file("a/x/f1.c"), file("a/x/f2.c"), file("a/y/f3.c"), file("b/z/f4.c"), file("b/z/f5.c")],
  edges: [],
};
const root = buildDirTree(graph);

// World boxes: the "a" subtree near the origin, "b" far to the right.
const boxes = new Map<string, Box>([
  ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
  ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
  ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
  ["b", { x: 2000, y: 0, w: 1000, h: 1000 }],
  ["b/z", { x: 2000, y: 0, w: 1000, h: 1000 }],
]);

const vp = { w: 800, h: 600 };
const base: CutOptions = { openPx: 220, maxCards: 1000 };
const cut = (cam: { x: number; y: number; scale: number }, opts: Partial<CutOptions> = {}) =>
  computeCut(root, boxes, cam, vp, { ...base, ...opts });

describe("computeCut", () => {
  test("fully zoomed out collapses every top-level directory", () => {
    const c = cut({ x: 0, y: 0, scale: 0.01 }); // every box ~10px tall
    expect([...c].sort()).toEqual(["a", "b"]);
  });

  test("zoomed into one region opens it and aggregates off-screen siblings", () => {
    const c = cut({ x: 0, y: 0, scale: 1 }); // 'a' fills view; 'b' is off to the right
    expect(c.has("b")).toBe(true); // off-screen → aggregated
    expect(c.has("a")).toBe(false); // open
    expect(c.has("a/x")).toBe(false); // open (files render)
    expect(c.has("a/y")).toBe(false);
  });

  test("off-screen directories are always collapsed", () => {
    // Pan so only 'b' is visible (shift world left by 2000*scale).
    const c = cut({ x: -2000, y: 0, scale: 1 });
    expect(c.has("a")).toBe(true); // 'a' now off-screen left
    expect(c.has("b")).toBe(false); // 'b' visible and large → open
  });

  test("respects the card budget", () => {
    const c = cut({ x: 0, y: 0, scale: 1 }, { maxCards: 2 });
    // 'a' opens (0 direct files), a/x opens (+2 files = budget), a/y can't → collapsed.
    expect(c.has("a/x")).toBe(false);
    expect(c.has("a/y")).toBe(true);
  });

  test("hysteresis keeps an already-open directory open under a small zoom-out", () => {
    // a/x box is 500 tall. At scale 0.4 → 200px < openPx(220): a fresh cut collapses it.
    const fresh = cut({ x: 0, y: 0, scale: 0.4 });
    expect(fresh.has("a/x")).toBe(true);
    // But if a/x was already open (∉ prevCut), threshold drops to 220*0.8=176 ≤ 200.
    const prev = cut({ x: 0, y: 0, scale: 1 }); // a/x open here
    const sticky = cut({ x: 0, y: 0, scale: 0.4 }, { prevCut: prev });
    expect(sticky.has("a/x")).toBe(false);
  });

  test("is deterministic", () => {
    const a = cut({ x: 0, y: 0, scale: 1 });
    const b = cut({ x: 0, y: 0, scale: 1 });
    expect(cutEquals(a, b)).toBe(true);
  });
});

describe("cutEquals", () => {
  test("compares set membership", () => {
    expect(cutEquals(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(cutEquals(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(cutEquals(new Set(), new Set())).toBe(true);
  });
});
