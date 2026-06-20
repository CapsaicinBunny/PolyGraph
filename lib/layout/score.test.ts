import { describe, expect, test } from "bun:test";
import { layoutScore, segmentsCross } from "./score";

const p = (x: number, y: number) => ({ x, y });

describe("segmentsCross", () => {
  test("detects a proper crossing (an X)", () => {
    expect(segmentsCross(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toBe(true);
  });
  test("parallel segments do not cross", () => {
    expect(segmentsCross(p(0, 0), p(10, 0), p(0, 10), p(10, 10))).toBe(false);
  });
});

describe("layoutScore", () => {
  const centers = new Map([
    ["A", p(0, 0)],
    ["B", p(100, 0)],
    ["C", p(100, 100)],
    ["D", p(0, 100)],
  ]);
  const sizes = new Map(["A", "B", "C", "D"].map((id) => [id, { w: 10, h: 10 }]));

  test("a crossing layout scores worse than a clean one", () => {
    const crossing = layoutScore(
      centers,
      sizes,
      [
        { source: "A", target: "C" },
        { source: "B", target: "D" },
      ],
      "LR",
    );
    const clean = layoutScore(
      centers,
      sizes,
      [
        { source: "A", target: "B" },
        { source: "C", target: "D" },
      ],
      "LR",
    );
    // The crossing layout costs ≥ a full crossing more (crossings dominate the small flow term).
    expect(crossing).toBeGreaterThan(clean + 5);
  });

  test("penalizes node overlap", () => {
    const tight = new Map([
      ["A", p(0, 0)],
      ["B", p(2, 0)],
    ]);
    const sz = new Map([
      ["A", { w: 10, h: 10 }],
      ["B", { w: 10, h: 10 }],
    ]);
    expect(layoutScore(tight, sz, [], "LR")).toBeGreaterThan(0); // overlapping pair
  });

  test("flow is measured by the requested direction, not the bounding box", () => {
    // B sits down-and-left of A: a forward edge under TB (downward), a backward edge under LR
    // (leftward). Same positions → only the requested direction changes the flow penalty.
    const c = new Map([
      ["A", p(500, 0)],
      ["B", p(0, 50)],
    ]);
    const sz = new Map([
      ["A", { w: 10, h: 10 }],
      ["B", { w: 10, h: 10 }],
    ]);
    const edges = [{ source: "A", target: "B" }];
    expect(layoutScore(c, sz, edges, "LR")).toBeGreaterThan(layoutScore(c, sz, edges, "TB"));
  });

  test("flowWeight 0 disables the flow penalty (cyclic graphs)", () => {
    const c = new Map([
      ["A", p(500, 0)],
      ["B", p(0, 50)],
    ]);
    const sz = new Map([
      ["A", { w: 10, h: 10 }],
      ["B", { w: 10, h: 10 }],
    ]);
    const edges = [{ source: "A", target: "B" }]; // backward under LR
    expect(layoutScore(c, sz, edges, "LR", 0)).toBe(layoutScore(c, sz, edges, "TB", 0));
  });
});
