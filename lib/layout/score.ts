// Layout quality scoring for the Smart planner's candidate comparison. Edge crossings are
// the strongest predictor of graph-drawing readability, with node overlap a close second
// (verified research basis), so the score is crossings (primary) + a smaller overlap
// penalty. Lower is better. Pure + deterministic. O(E² + N²) — callers gate by cluster size.

export interface Pt {
  x: number;
  y: number;
}
interface Edge {
  source: string;
  target: string;
}

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
 * Score a candidate layout: number of edge crossings plus half the number of overlapping
 * node pairs. `centers` are node center points; `sizes` are card width/height for overlap.
 */
export function layoutScore(
  centers: Map<string, Pt>,
  sizes: Map<string, { w: number; h: number }>,
  edges: Edge[],
): number {
  const segs = edges
    .map((e) => ({ a: centers.get(e.source), b: centers.get(e.target), s: e.source, t: e.target }))
    .filter((x): x is { a: Pt; b: Pt; s: string; t: string } => !!x.a && !!x.b);
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i];
      const B = segs[j];
      // Adjacent edges (sharing an endpoint) can't "cross" in the readability sense.
      if (A.s === B.s || A.s === B.t || A.t === B.s || A.t === B.t) continue;
      if (segmentsCross(A.a, A.b, B.a, B.b)) crossings += 1;
    }
  }

  const ids = [...centers.keys()];
  let overlaps = 0;
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
  return crossings + 0.5 * overlaps;
}
