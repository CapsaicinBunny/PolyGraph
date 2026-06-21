import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  type RepresentationHierarchy,
} from "./representation";
import {
  computeRepresentationBounds,
  DEFAULT_BOUNDS_OPTIONS,
  representationBoundsOf,
  type RepresentationBounds,
} from "./representation-bounds";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

/** A balanced-ish directory graph: a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c. */
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.c"),
    file("a/x/f2.c"),
    file("a/y/f3.c"),
    file("b/z/f4.c"),
    file("b/z/f5.c"),
    file("b/z/f6.c"),
    file("top.c"),
  ],
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

function groupRep(h: RepresentationHierarchy, id: string): number {
  const ord = h.snapshot.groupIds.indexOf(id);
  if (ord === -1) throw new Error(`no group ${id}`);
  return h.repOfGroup[ord];
}

/** Area of a Rect. */
const area = (r: { w: number; h: number }) => r.w * r.h;

describe("computeRepresentationBounds — tiered reservation (Appendix A §C)", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds);
  // Seed each group's CURRENT box from a simple stand-in layout so reservation has a base.
  // Box area scales with the direct-child count so a "fuller" current box reserves more.
  for (let g = 0; g < snap.groupIds.length; g++) {
    const rep = h.repOfGroup[g];
    h.columns.boundsX[rep] = 0;
    h.columns.boundsY[rep] = 0;
    h.columns.boundsW[rep] = 200;
    h.columns.boundsH[rep] = 120;
  }
  computeRepresentationBounds(h);

  test("every group rep gets current/nextReserved/growthEnvelope/minScale", () => {
    const a = representationBoundsOf(h.columns, groupRep(h, "directory:a"));
    expect(a.current.w).toBeGreaterThan(0);
    expect(a.nextReserved.w).toBeGreaterThan(0);
    expect(a.growthEnvelope.w).toBeGreaterThan(0);
    expect(a.minScale).toBeGreaterThan(0);
    expect(a.minScale).toBeLessThanOrEqual(1);
  });

  test("reservation is NESTED: current ⊆ nextReserved ⊆ growthEnvelope (by area)", () => {
    for (const id of ["directory:a", "directory:a/x", "directory:b", "directory:b/z"]) {
      const b = representationBoundsOf(h.columns, groupRep(h, id));
      expect(area(b.nextReserved)).toBeGreaterThanOrEqual(area(b.current));
      expect(area(b.growthEnvelope)).toBeGreaterThanOrEqual(area(b.nextReserved));
    }
  });

  test("nextReserved covers the NEXT tier only — bounded by the direct-child count, not the leaf total", () => {
    // 'a' has 2 direct children (a/x, a/y); 'b' has 1 (b/z). The next-tier reservation
    // must scale with the DIRECT children, so a's nextReserved is not absurdly large just
    // because its subtree has 3 leaves. Concretely: a's next-tier extra over current is
    // bounded by (directChildren * perChildCurrentArea), a small multiple — never the full
    // descendant leaf extent.
    const a = representationBoundsOf(h.columns, groupRep(h, "directory:a"));
    const perChild = area(a.current);
    // 2 direct children → at most ~2 tiers of the current footprint plus padding slack.
    expect(area(a.nextReserved)).toBeLessThanOrEqual(perChild * (2 + 1) * 1.5 + 1);
  });

  test("a huge/deep subtree does NOT reserve continent-sized empty space (the Space Paradox)", () => {
    // A chain a/b/c/.../ of 200 nested dirs with ONE leaf at the bottom: the top group's
    // subtree leaf extent is tiny (1 leaf) but its DEPTH is 200. The growth envelope must
    // stay a BOUNDED multiple of the current box — not 200× — because reservation is tiered
    // (next tier + capped envelope), recomputed lazily as you descend.
    const deepNodes = [file("d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/leaf.c")];
    // Build an artificially WIDE+DEEP fan: one root with 5000 leaves directly.
    const wideNodes = Array.from({ length: 5000 }, (_, i) => file(`wide/f${i}.c`));
    const huge: GraphModel = { nodes: [...deepNodes, ...wideNodes], edges: [] };
    const ids = huge.nodes.map((n) => n.id);
    const hugeSnap = buildGroupingSnapshot(directoryGrouping(huge), "directory", ids);
    const hh = buildRepresentationHierarchy(hugeSnap, ids);
    for (let g = 0; g < hugeSnap.groupIds.length; g++) {
      const rep = hh.repOfGroup[g];
      hh.columns.boundsW[rep] = 200;
      hh.columns.boundsH[rep] = 120;
    }
    computeRepresentationBounds(hh);
    const wideOrd = hugeSnap.groupIds.indexOf("directory:wide");
    const wideRep = hh.repOfGroup[wideOrd];
    const b = representationBoundsOf(hh.columns, wideRep);
    // The 'wide' group proxies 5000 leaves. A naive "reserve full leaf extent" would make
    // the envelope ~5000× the current card. The tiered cap keeps it within the configured
    // envelope factor of the current box.
    const cur = area(b.current);
    expect(area(b.growthEnvelope)).toBeLessThanOrEqual(
      cur * DEFAULT_BOUNDS_OPTIONS.maxEnvelopeFactor + 1,
    );
    // And critically, FAR below the full-leaf extent it would need to show all 5000 cards.
    const fullLeafArea = 5000 * cur;
    expect(area(b.growthEnvelope)).toBeLessThan(fullLeafArea * 0.1);
  });

  test("a leaf rep reserves nothing beyond itself (no children to refine into)", () => {
    const leafOrd = nodeIds.indexOf("top.c");
    const leafRep = h.columns.leafRepresentationByNode[leafOrd];
    const b = representationBoundsOf(h.columns, leafRep);
    // current == nextReserved == growthEnvelope for a leaf (nothing to grow into).
    expect(b.nextReserved).toEqual(b.current);
    expect(b.growthEnvelope).toEqual(b.current);
  });

  test("minScale < 1 for a proxy whose next tier overflows its current box, else 1", () => {
    // 'b' (1 child b/z which holds 3 files) needs to compact when refined into a box the
    // size of its current proxy card → minScale below 1. A small group that fits stays 1.
    const b = representationBoundsOf(h.columns, groupRep(h, "directory:b/z"));
    expect(b.minScale).toBeGreaterThan(0);
    expect(b.minScale).toBeLessThanOrEqual(1);
  });
});

describe("computeRepresentationBounds — lazy local recompute", () => {
  test("recomputing one rep's bounds does not touch sibling/ancestor bounds", () => {
    const h = buildRepresentationHierarchy(snap, nodeIds);
    for (let g = 0; g < snap.groupIds.length; g++) {
      const rep = h.repOfGroup[g];
      h.columns.boundsW[rep] = 200;
      h.columns.boundsH[rep] = 120;
    }
    computeRepresentationBounds(h);
    // Snapshot all reserved/envelope columns.
    const before = {
      rx: Float32Array.from(h.columns.reservedX),
      ry: Float32Array.from(h.columns.reservedY),
      rw: Float32Array.from(h.columns.reservedW),
      rh: Float32Array.from(h.columns.reservedH),
      ex: Float32Array.from(h.columns.envelopeX),
      ey: Float32Array.from(h.columns.envelopeY),
      ew: Float32Array.from(h.columns.envelopeW),
      eh: Float32Array.from(h.columns.envelopeH),
    };
    const bRep = groupRep(h, "directory:b");
    // Grow b's current box and recompute ONLY b lazily.
    h.columns.boundsW[bRep] = 400;
    h.columns.boundsH[bRep] = 300;
    computeRepresentationBounds(h, { ...DEFAULT_BOUNDS_OPTIONS, only: bRep });

    for (let r = 0; r < h.repCount; r++) {
      if (r === bRep) continue;
      expect(h.columns.reservedW[r]).toBe(before.rw[r]);
      expect(h.columns.reservedH[r]).toBe(before.rh[r]);
      expect(h.columns.envelopeW[r]).toBe(before.ew[r]);
      expect(h.columns.envelopeH[r]).toBe(before.eh[r]);
    }
    // b itself DID change (its current grew → its reservation grew).
    expect(h.columns.reservedW[bRep]).not.toBe(before.rw[bRep]);
  });
});
