import { describe, expect, test } from "bun:test";
import { pivotMds } from "./stress";

const E = (s: string, t: string) => ({ source: s, target: t });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("pivotMds (landmark stress embedding)", () => {
  // A path 0–1–…–11: graph distance grows monotonically along it.
  const pathIds = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const pathEdges = pathIds.slice(1).map((id, i) => E(pathIds[i], id));

  test("is deterministic across runs", () => {
    const a = pivotMds(pathIds, pathEdges, 6);
    const b = pivotMds(pathIds, pathEdges, 6);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("positions every node with finite coordinates", () => {
    const out = pivotMds(pathIds, pathEdges, 6);
    expect(out.size).toBe(pathIds.length);
    for (const p of out.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  test("roughly preserves graph distance (far-in-graph → far-in-embedding)", () => {
    const out = pivotMds(pathIds, pathEdges, 6);
    const ends = dist(out.get("n0")!, out.get("n11")!);
    const adjacent = dist(out.get("n0")!, out.get("n1")!);
    expect(ends).toBeGreaterThan(adjacent * 3); // the path's endpoints are far apart
  });

  test("does not collapse a grid graph to a line (recovers 2-D structure)", () => {
    // 6×6 lattice → a genuinely 2-D shape; the embedding should have real spread on both axes.
    const ids: string[] = [];
    const edges: { source: string; target: string }[] = [];
    const at = (r: number, c: number) => `g${r}_${c}`;
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 6; c++) {
        ids.push(at(r, c));
        if (c > 0) edges.push(E(at(r, c - 1), at(r, c)));
        if (r > 0) edges.push(E(at(r - 1, c), at(r, c)));
      }
    const out = pivotMds(ids, edges, 10);
    const xs = [...out.values()].map((p) => p.x);
    const ys = [...out.values()].map((p) => p.y);
    const span = (v: number[]) => Math.max(...v) - Math.min(...v);
    // Both axes carry real extent (ratio bounded) → not collapsed onto one line.
    expect(span(xs)).toBeGreaterThan(0);
    expect(span(ys)).toBeGreaterThan(0);
    expect(span(ys) / span(xs)).toBeGreaterThan(0.15);
  });
});
