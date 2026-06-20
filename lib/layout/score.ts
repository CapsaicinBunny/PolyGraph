// Layout quality scoring for the Smart planner's candidate comparison. Edge crossings are
// the strongest predictor of graph-drawing readability, with node overlap a close second
// (verified research basis), so the score is crossings (primary) + a smaller overlap
// penalty. Lower is better. Pure + deterministic. O(E² + N²) — callers gate by cluster size.

import type { LayoutDirection } from "../layout";

export interface Pt {
  x: number;
  y: number;
}
interface Edge {
  source: string;
  target: string;
  weight?: number;
}

interface ScoreOptions {
  /** Weight of the backward-flow term (0 disables it — for heavily cyclic graphs). */
  flowWeight?: number;
  /** Previous node CENTERS, for the mental-map (movement) term. */
  previous?: Map<string, Pt>;
  /** Weight of the movement term (0 = off). Kept modest so a clearly better layout still wins. */
  movementWeight?: number;
}

// Relationship importance: an `extends`/`implements` edge should count for more than an
// incidental `call` when weighing crossings + flow. 1 for unweighted edges, ~4 for the heaviest.
const importanceOf = (weight: number | undefined): number => 1 + Math.log2(1 + (weight ?? 0));

/** Signed area of triangle (a,b,c) ×2 — sign gives orientation. */
function cross3(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Do open segments a–b and c–d properly cross (excluding shared endpoints / touching)? */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/**
 * Score a candidate layout (lower = better). Weighted so the dimensions don't trade off
 * wrongly: node overlap is worst, then crossings, then flow violations, then a gentle
 * penalty for an extreme aspect ratio. The flow term (directed edges that run backward along
 * the REQUESTED direction) stops a clean-looking-but-flow-destroying engine — e.g. Force on a
 * DAG — from beating Layered on a one-crossing technicality. `edges` are directed; pass
 * flowWeight 0 to disable the flow term for heavily cyclic graphs (where "backward" is moot).
 */
export function layoutScore(
  centers: Map<string, Pt>,
  sizes: Map<string, { w: number; h: number }>,
  edges: Edge[],
  direction: LayoutDirection,
  opts: ScoreOptions = {},
): number {
  const flowWeight = opts.flowWeight ?? 4;
  const segs = edges
    .map((e) => ({
      a: centers.get(e.source),
      b: centers.get(e.target),
      s: e.source,
      t: e.target,
      imp: importanceOf(e.weight),
    }))
    .filter((x): x is { a: Pt; b: Pt; s: string; t: string; imp: number } => !!x.a && !!x.b);
  // Crossings weighted by the importance of the two crossing edges (heavier relationships
  // crossing is worse). For unweighted edges imp = 1, so this reduces to a plain crossing count.
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i];
      const B = segs[j];
      // Adjacent edges (sharing an endpoint) can't "cross" in the readability sense.
      if (A.s === B.s || A.s === B.t || A.t === B.s || A.t === B.t) continue;
      if (segmentsCross(A.a, A.b, B.a, B.b)) crossings += (A.imp + B.imp) / 2;
    }
  }

  const ids = [...centers.keys()];
  let overlaps = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of centers.values()) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ca = centers.get(ids[i])!;
      const cb = centers.get(ids[j])!;
      const sa = sizes.get(ids[i])!;
      const sb = sizes.get(ids[j])!;
      if (Math.abs(ca.x - cb.x) < (sa.w + sb.w) / 2 && Math.abs(ca.y - cb.y) < (sa.h + sb.h) / 2)
        overlaps += 1;
    }
  }

  // Flow violations: directed edges running backward along the REQUESTED direction (not the
  // bounding box — a TB layout that's wider than tall must still measure top-to-bottom),
  // weighted by relationship importance (a backward `extends` is worse than a backward call).
  let backward = 0;
  if (flowWeight > 0) {
    for (const seg of segs) {
      const bad =
        direction === "LR"
          ? seg.b.x < seg.a.x
          : direction === "RL"
            ? seg.b.x > seg.a.x
            : direction === "BT"
              ? seg.b.y > seg.a.y
              : seg.b.y < seg.a.y; // TB (default)
      if (bad) backward += seg.imp;
    }
  }

  // Mental-map term: how much the candidate rearranges nodes vs. the previous layout, ignoring
  // a uniform translation (so a layout that merely shifts keeps its mental map). Modest weight.
  let movement = 0;
  const movementWeight = opts.movementWeight ?? 0;
  if (movementWeight > 0 && opts.previous) {
    let dxSum = 0;
    let dySum = 0;
    let cnt = 0;
    for (const [id, c] of centers) {
      const o = opts.previous.get(id);
      if (o) {
        dxSum += c.x - o.x;
        dySum += c.y - o.y;
        cnt += 1;
      }
    }
    if (cnt > 0) {
      const mdx = dxSum / cnt;
      const mdy = dySum / cnt;
      const diag = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
      for (const [id, c] of centers) {
        const o = opts.previous.get(id);
        if (o) movement += Math.hypot(c.x - o.x - mdx, c.y - o.y - mdy) / diag;
      }
    }
  }

  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const aspect = Math.max(w / h, h / w);
  const aspectPenalty = Math.max(0, aspect - 4) * 3; // only bite past ~4:1

  return (
    overlaps * 100 +
    crossings * 10 +
    backward * flowWeight +
    movement * movementWeight +
    aspectPenalty
  );
}
