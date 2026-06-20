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
    const crossing = layoutScore(centers, sizes, [
      { source: "A", target: "C" },
      { source: "B", target: "D" },
    ]);
    const clean = layoutScore(centers, sizes, [
      { source: "A", target: "B" },
      { source: "C", target: "D" },
    ]);
    expect(clean).toBe(0); // no crossings, cards far apart → no overlap
    expect(crossing).toBeGreaterThan(clean);
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
    expect(layoutScore(tight, sz, [])).toBeGreaterThan(0); // overlapping pair
  });
});
