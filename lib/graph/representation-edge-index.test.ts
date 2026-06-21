import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy, type RepresentationHierarchy } from "./representation";
import {
  buildRepresentationEdgeIndex,
  type EdgeIndexInput,
  edgesBetween,
  incomingBoundary,
  outgoingBoundary,
} from "./representation-edge-index";
import type { GraphModel } from "./types";

// A small multi-group graph: directories a/x, a/y, b/z.
//   a/x/{f1,f2}, a/y/{f3}, b/z/{f4,f5}
const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

const graph: GraphModel = {
  nodes: [file("a/x/f1.c"), file("a/x/f2.c"), file("a/y/f3.c"), file("b/z/f4.c"), file("b/z/f5.c")],
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const ordOf = new Map(nodeIds.map((id, i) => [id, i]));
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

// Build WITH bootstrap normalization so the root groups "a" and "b" share a synthetic
// super-root parent (design B1). Without it, "a" and "b" are independent roots with no common
// ancestor, so a cross-root edge has NO lowest relevant rep pair and is dropped — exactly the
// bootstrap-feasibility gap the super-root closes. The edge index relies on that common ancestor
// to summarize cross-group boundaries, so the production runtime always builds with bootstrap.
const boot = { bootstrapRoots: true } as const;

function groupRep(h: RepresentationHierarchy, dir: string): number {
  // Directory grouping namespaces ids as "directory:<path>".
  return h.repOfGroup[h.snapshot.groupIds.indexOf(`directory:${dir}`)];
}
function leafRep(h: RepresentationHierarchy, nodeId: string): number {
  return h.columns.leafRepresentationByNode[nodeIds.indexOf(nodeId)];
}

/** An edge by node id (resolved to ordinals), kind 0 by default. */
const edge = (s: string, t: string, kind = 0, weight = 1): EdgeIndexInput => ({
  source: ordOf.get(s)!,
  target: ordOf.get(t)!,
  kind,
  weight,
});

describe("buildRepresentationEdgeIndex — CSR layout + invariants", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds, boot);

  test("columns are the documented typed-array kinds (CSR, not Uint32Array[])", () => {
    const idx = buildRepresentationEdgeIndex(h, [edge("a/x/f1.c", "b/z/f4.c")]);
    expect(idx.outgoingOffsets).toBeInstanceOf(Uint32Array);
    expect(idx.outgoingTargets).toBeInstanceOf(Uint32Array);
    expect(idx.outgoingKinds).toBeInstanceOf(Uint16Array);
    expect(idx.outgoingCounts).toBeInstanceOf(Uint32Array);
    expect(idx.incomingOffsets).toBeInstanceOf(Uint32Array);
    expect(idx.incomingSources).toBeInstanceOf(Uint32Array);
    expect(idx.rangeOffsets).toBeInstanceOf(Uint32Array);
    expect(idx.originalEdgeOrdinals).toBeInstanceOf(Uint32Array);
  });

  test("offset arrays are length repCount+1 and monotonic non-decreasing", () => {
    const idx = buildRepresentationEdgeIndex(h, [edge("a/x/f1.c", "a/y/f3.c")]);
    expect(idx.outgoingOffsets.length).toBe(h.repCount + 1);
    expect(idx.incomingOffsets.length).toBe(h.repCount + 1);
    for (let r = 0; r < h.repCount; r++) {
      expect(idx.outgoingOffsets[r + 1]).toBeGreaterThanOrEqual(idx.outgoingOffsets[r]);
      expect(idx.incomingOffsets[r + 1]).toBeGreaterThanOrEqual(idx.incomingOffsets[r]);
    }
    expect(idx.outgoingOffsets[h.repCount]).toBe(idx.outgoingTargets.length);
    expect(idx.incomingOffsets[h.repCount]).toBe(idx.incomingSources.length);
    expect(idx.rangeOffsets[idx.pairCount]).toBe(idx.originalEdgeOrdinals.length);
  });

  test("an empty edge set yields empty boundary + range CSRs", () => {
    const idx = buildRepresentationEdgeIndex(h, []);
    expect(idx.outgoingTargets.length).toBe(0);
    expect(idx.incomingSources.length).toBe(0);
    expect(idx.pairCount).toBe(0);
    expect(idx.originalEdgeOrdinals.length).toBe(0);
  });

  test("self-loops and same-leaf edges are dropped", () => {
    const idx = buildRepresentationEdgeIndex(h, [edge("a/x/f1.c", "a/x/f1.c")]);
    expect(idx.pairCount).toBe(0);
    expect(idx.outgoingTargets.length).toBe(0);
  });
});

describe("boundary summaries — correct on a small multi-group graph", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds, boot);
  // Groups: "a" is parent of "a/x" and "a/y"; "b" parent of "b/z". Roots are "a" and "b".
  const repA = groupRep(h, "a");
  const repB = groupRep(h, "b");
  const repAX = groupRep(h, "a/x");
  const repAY = groupRep(h, "a/y");

  test("a cross-root edge (a/x/f1 → b/z/f4) summarizes at the root tier a ↔ b", () => {
    const idx = buildRepresentationEdgeIndex(h, [edge("a/x/f1.c", "b/z/f4.c")]);
    // The LCA of the two leaves is the forest super-structure; the lowest relevant rep pair is
    // (a's subtree child, b's subtree child) — the two ROOT group reps a and b.
    const out = outgoingBoundary(idx, repA);
    expect(out).toEqual([{ target: repB, kind: 0, count: 1 }]);
    const inc = incomingBoundary(idx, repB);
    expect(inc).toEqual([{ source: repA, count: 1 }]);
    // Symmetric reverse direction is NOT present (the edge is directed a→b).
    expect(outgoingBoundary(idx, repB)).toEqual([]);
    expect(incomingBoundary(idx, repA)).toEqual([]);
  });

  test("an in-'a' edge (a/x/f1 → a/y/f3) summarizes at the a/x ↔ a/y tier", () => {
    const idx = buildRepresentationEdgeIndex(h, [edge("a/x/f1.c", "a/y/f3.c")]);
    // LCA group is "a"; the lowest relevant pair is its two children a/x and a/y.
    expect(outgoingBoundary(idx, repAX)).toEqual([{ target: repAY, kind: 0, count: 1 }]);
    expect(incomingBoundary(idx, repAY)).toEqual([{ source: repAX, count: 1 }]);
    // It does NOT appear at the root a↔b tier.
    expect(outgoingBoundary(idx, repA)).toEqual([]);
  });

  test("parallel edges of the same kind aggregate into one boundary entry with summed count", () => {
    const idx = buildRepresentationEdgeIndex(h, [
      edge("a/x/f1.c", "a/y/f3.c", 0, 1),
      edge("a/x/f2.c", "a/y/f3.c", 0, 2),
    ]);
    // Both lift to the a/x ↔ a/y boundary, same kind → one entry, count 3.
    expect(outgoingBoundary(idx, repAX)).toEqual([{ target: repAY, kind: 0, count: 3 }]);
  });

  test("different kinds on the same boundary are distinct entries (sorted by kind)", () => {
    const idx = buildRepresentationEdgeIndex(h, [
      edge("a/x/f1.c", "a/y/f3.c", 2),
      edge("a/x/f2.c", "a/y/f3.c", 1),
    ]);
    expect(outgoingBoundary(idx, repAX)).toEqual([
      { target: repAY, kind: 1, count: 1 },
      { target: repAY, kind: 2, count: 1 },
    ]);
  });
});

describe("edge-range round-trip — real edges under a proxy↔proxy boundary", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds, boot);
  const repA = groupRep(h, "a");
  const repB = groupRep(h, "b");
  const repAX = groupRep(h, "a/x");
  const repAY = groupRep(h, "a/y");

  const inputs = [
    edge("a/x/f1.c", "a/y/f3.c"), // 0: a/x ↔ a/y
    edge("a/x/f2.c", "b/z/f4.c"), // 1: a ↔ b
    edge("a/x/f1.c", "b/z/f5.c"), // 2: a ↔ b
    edge("a/x/f1.c", "a/x/f2.c"), // 3: internal to a/x — same group, but the two LEAVES differ
  ];
  const idx = buildRepresentationEdgeIndex(h, inputs);

  test("edgesBetween returns exactly the original ordinals crossing that boundary", () => {
    const ab = [...edgesBetween(idx, repA, repB)];
    expect(ab.sort((x, y) => x - y)).toEqual([1, 2]);
    const axy = [...edgesBetween(idx, repAX, repAY)];
    expect(axy).toEqual([0]);
  });

  test("the boundary is undirected — argument order does not matter", () => {
    expect([...edgesBetween(idx, repB, repA)].sort((x, y) => x - y)).toEqual([1, 2]);
  });

  test("round-trip: every returned ordinal is an edge whose endpoints straddle the boundary", () => {
    for (const ord of edgesBetween(idx, repA, repB)) {
      const e = inputs[ord];
      const srcPath = nodeIds[e.source];
      const dstPath = nodeIds[e.target];
      // One endpoint under "a", the other under "b".
      const aSide = srcPath.startsWith("a/") ? srcPath : dstPath;
      const bSide = srcPath.startsWith("b/") ? srcPath : dstPath;
      expect(aSide.startsWith("a/")).toBe(true);
      expect(bSide.startsWith("b/")).toBe(true);
    }
  });

  test("an edge between two leaves of the SAME lowest group keys at the two leaf reps", () => {
    // inputs[3] is a/x/f1 → a/x/f2: the LCA is a/x, and its two children are the leaf reps.
    const lf1 = leafRep(h, "a/x/f1.c");
    const lf2 = leafRep(h, "a/x/f2.c");
    expect([...edgesBetween(idx, lf1, lf2)]).toEqual([3]);
  });

  test("a boundary with no edges returns an empty range", () => {
    expect(edgesBetween(idx, repAY, repB).length).toBe(0);
  });

  test("range ordinals are ascending within each pair (deterministic round-trip)", () => {
    const ab = edgesBetween(idx, repA, repB);
    for (let i = 1; i < ab.length; i++) expect(ab[i]).toBeGreaterThan(ab[i - 1]);
  });
});

describe("post-filter — hidden endpoints are dropped", () => {
  test("an edge to a hidden node is excluded from summaries and ranges", () => {
    // Hide b/z/f4 and b/z/f5 (the whole b subtree). The b group rep detaches.
    const hidden = new Set([ordOf.get("b/z/f4.c"), ordOf.get("b/z/f5.c")]);
    const h = buildRepresentationHierarchy(snap, nodeIds, {
      visibleNode: (ord) => !hidden.has(ord),
    });
    const repA = groupRep(h, "a");
    const idx = buildRepresentationEdgeIndex(h, [
      edge("a/x/f1.c", "b/z/f4.c"), // hidden target — dropped
      edge("a/x/f1.c", "a/y/f3.c"), // both visible — kept
    ]);
    expect(idx.pairCount).toBe(1); // only the a/x ↔ a/y range survives
    // a has no surviving cross-root edge.
    expect(outgoingBoundary(idx, repA)).toEqual([]);
  });
});
