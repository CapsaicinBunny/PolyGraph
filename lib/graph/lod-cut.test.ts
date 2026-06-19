import { describe, expect, test } from "bun:test";
import { buildDirTree } from "./hierarchy";
import { type Box } from "./lod-screen";
import { computeCut, computeCutTraced, type CutOptions, cutEquals } from "./lod-cut";
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

describe("computeCut node budget", () => {
  // At scale 1 the default cut opens 'a', 'a/x' and 'a/y' (see above). A node budget
  // models symbol cost: when each file is expanded it adds its symbols to the layout,
  // so opening a dir can blow past what Smart can lay out even though the CARD budget
  // is fine. nodeCost(f) = 1 + symbols(f).
  const heavy = () => 101; // every file costs 1 + 100 symbols

  test("default nodeCost/nodeBudget leave the cut unchanged", () => {
    const withDefaults = cut({ x: 0, y: 0, scale: 1 }, { nodeBudget: Infinity });
    expect(cutEquals(withDefaults, cut({ x: 0, y: 0, scale: 1 }))).toBe(true);
  });

  test("collapses symbol-heavy directories the card budget would open", () => {
    const c = cut({ x: 0, y: 0, scale: 1 }, { nodeBudget: 50, nodeCost: heavy });
    expect(c.has("a/x")).toBe(true); // 2 files × 101 = 202 > 50 → collapse
    expect(c.has("a/y")).toBe(true); // would push the running total over 50 too
    // Without the node budget those same dirs open:
    const d = cut({ x: 0, y: 0, scale: 1 });
    expect(d.has("a/x")).toBe(false);
    expect(d.has("a/y")).toBe(false);
  });

  test("opens what fits and collapses the overflow (heaviest dir first)", () => {
    const c = cut({ x: 0, y: 0, scale: 1 }, { nodeBudget: 150, nodeCost: heavy });
    expect(c.has("a/x")).toBe(true); // visited first (2 files), 202 > 150 → collapse
    expect(c.has("a/y")).toBe(false); // 1 file × 101 = 101 fits the remaining budget → open
  });

  test("root-level files count against the node budget (reserve headroom)", () => {
    // A repo-root file can't be collapsed away; its cost must still consume the budget
    // so the cut doesn't open dirs on top of it and overrun the layout engine.
    const rootGraph: GraphModel = {
      nodes: [file("big.c"), file("a/x/f1.c"), file("a/x/f2.c")],
      edges: [],
    };
    const rootTree = buildDirTree(rootGraph);
    const rootBoxes = new Map<string, Box>([
      ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
      ["a/x", { x: 0, y: 0, w: 1000, h: 1000 }],
    ]);
    const heavyRoot = (id: string) => (id === "big.c" ? 199 : 1);
    const opts = { openPx: 220, maxCards: 1000, nodeBudget: 200, nodeCost: heavyRoot };
    const c = computeCut(rootTree, rootBoxes, { x: 0, y: 0, scale: 1 }, vp, opts);
    // big.c (199) eats almost the whole 200 budget, so a/x (2 nodes) can't open on top.
    expect(c.has("a/x")).toBe(true);
    // Without root files counted, the same budget would open a/x (2 ≤ 200):
    const ignoreRoot = { ...opts, nodeCost: () => 1 as number };
    const c2 = computeCut(rootTree, rootBoxes, { x: 0, y: 0, scale: 1 }, vp, ignoreRoot);
    expect(c2.has("a/x")).toBe(false);
  });
});

describe("computeCutTraced", () => {
  test("returns the same cut as computeCut, plus a per-dir decision trace", () => {
    const cam = { x: 0, y: 0, scale: 1 };
    const plain = computeCut(root, boxes, cam, vp, base);
    const traced = computeCutTraced(root, boxes, cam, vp, base);
    expect(cutEquals(traced.cut, plain)).toBe(true);

    const byPath = new Map(traced.trace.map((e) => [e.path, e]));
    // 'b' is off-screen (panned far right) → collapsed for that reason.
    expect(byPath.get("b")).toMatchObject({
      decision: "collapse",
      reason: "off-screen",
      onScreen: false,
    });
    // 'a' is big and on-screen → opened.
    expect(byPath.get("a")).toMatchObject({ decision: "open", reason: "opened", onScreen: true });
    expect(byPath.get("a")!.screenHeightPx).toBe(1000); // 1000 world * scale 1
  });

  test("records 'too-small' when a dir is on screen but below the threshold", () => {
    // scale 0.4: a/x box (500 tall) → 200px < openPx(220) → too-small.
    const traced = computeCutTraced(root, boxes, { x: 0, y: 0, scale: 0.4 }, vp, base);
    const ax = traced.trace.find((e) => e.path === "a/x");
    expect(ax).toMatchObject({ onScreen: true, decision: "collapse", reason: "too-small" });
    expect(ax!.screenHeightPx).toBe(200);
  });

  test("reports budget reason and counts when the card budget is hit", () => {
    const traced = computeCutTraced(root, boxes, { x: 0, y: 0, scale: 1 }, vp, {
      ...base,
      maxCards: 2,
    });
    expect(traced.trace.some((e) => e.reason === "budget")).toBe(true);
    expect(traced.dirsEvaluated).toBeGreaterThan(0);
    expect(traced.cards).toBeGreaterThan(0);
  });

  test("counts directories evaluated and on screen", () => {
    const traced = computeCutTraced(root, boxes, { x: 0, y: 0, scale: 1 }, vp, base);
    expect(traced.dirsEvaluated).toBe(traced.trace.length);
    expect(traced.dirsOnScreen).toBeLessThanOrEqual(traced.dirsEvaluated);
  });

  test("traces the lowered hysteresis threshold for an already-open dir", () => {
    const prev = computeCut(root, boxes, { x: 0, y: 0, scale: 1 }, vp, base); // a/x open here
    // a/x box is 500 tall → 200px at scale 0.4. Already-open → threshold drops to
    // 220*0.8 = 176 ≤ 200, so it stays open; the trace must report that 176.
    const sticky = computeCutTraced(root, boxes, { x: 0, y: 0, scale: 0.4 }, vp, {
      ...base,
      prevCut: prev,
    });
    const ax = sticky.trace.find((e) => e.path === "a/x");
    expect(ax).toMatchObject({ decision: "open", reason: "opened" });
    expect(ax!.thresholdPx).toBe(176);
    // Without prevCut the same camera collapses a/x at the full 220 threshold.
    const fresh = computeCutTraced(root, boxes, { x: 0, y: 0, scale: 0.4 }, vp, base);
    const axFresh = fresh.trace.find((e) => e.path === "a/x");
    expect(axFresh).toMatchObject({ decision: "collapse", reason: "too-small" });
    expect(axFresh!.thresholdPx).toBe(220);
  });
});

describe("cutEquals", () => {
  test("compares set membership", () => {
    expect(cutEquals(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(cutEquals(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(cutEquals(new Set(), new Set())).toBe(true);
  });
});
