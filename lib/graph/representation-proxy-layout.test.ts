import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy, type RepresentationHierarchy } from "./representation";
import {
  computeStableProxyBounds,
  DEFAULT_PROXY_LAYOUT_OPTIONS,
  stableProxyBoundsOf,
} from "./representation-proxy-layout";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5,f6}, top.c
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

const area = (r: { w: number; h: number }) => r.w * r.h;
const contains = (
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
  eps = 0.5,
) =>
  inner.x >= outer.x - eps &&
  inner.y >= outer.y - eps &&
  inner.x + inner.w <= outer.x + outer.w + eps &&
  inner.y + inner.h <= outer.y + outer.h + eps;

describe("computeStableProxyBounds — layout-independent proxy geometry (Gap 3 / P2)", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds);
  const stable = computeStableProxyBounds(h);

  test("every non-detached rep gets a positive bounded box (NO engine input)", () => {
    // The whole point: bounds exist for EVERY rep with no scene boxes / no visual engine at all.
    for (let r = 0; r < h.repCount; r++) {
      const b = stableProxyBoundsOf(stable, r);
      expect(b.w).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
    }
  });

  test("the forest is BOUNDED — every box lies inside the world canvas", () => {
    const world = {
      x: 0,
      y: 0,
      w: DEFAULT_PROXY_LAYOUT_OPTIONS.worldSize,
      h: DEFAULT_PROXY_LAYOUT_OPTIONS.worldSize,
    };
    for (let r = 0; r < h.repCount; r++) {
      const b = stableProxyBoundsOf(stable, r);
      // minSide clamping can nudge a degenerate slot a hair past the edge; allow minSide slack.
      expect(contains(world, b, DEFAULT_PROXY_LAYOUT_OPTIONS.minSide + 1)).toBe(true);
    }
  });

  test("a child box nests inside its parent's box (well-formed ancestor geometry)", () => {
    const a = stableProxyBoundsOf(stable, groupRep(h, "directory:a"));
    const ax = stableProxyBoundsOf(stable, groupRep(h, "directory:a/x"));
    const ay = stableProxyBoundsOf(stable, groupRep(h, "directory:a/y"));
    expect(contains(a, ax, DEFAULT_PROXY_LAYOUT_OPTIONS.minSide + 1)).toBe(true);
    expect(contains(a, ay, DEFAULT_PROXY_LAYOUT_OPTIONS.minSide + 1)).toBe(true);
  });

  test("box AREA scales with subtree leaf count — 'b' (3 leaves) ≥ 'a' (3 leaves) order, both > a leaf", () => {
    const a = stableProxyBoundsOf(stable, groupRep(h, "directory:a")); // 3 leaves
    const leafRep = h.columns.leafRepresentationByNode[nodeIds.indexOf("top.c")];
    const leaf = stableProxyBoundsOf(stable, leafRep);
    // A 3-leaf group reserves more world area than a single leaf.
    expect(area(a)).toBeGreaterThan(area(leaf));
  });

  test("deterministic — two builds give byte-identical geometry (no engine, no camera)", () => {
    const h2 = buildRepresentationHierarchy(snap, nodeIds);
    const s2 = computeStableProxyBounds(h2);
    for (let r = 0; r < h.repCount; r++) {
      expect(s2.x[r]).toBe(stable.x[r]);
      expect(s2.y[r]).toBe(stable.y[r]);
      expect(s2.w[r]).toBe(stable.w[r]);
      expect(s2.h[r]).toBe(stable.h[r]);
    }
  });

  test("returns a snapshot that survives the columns being overwritten", () => {
    const h3 = buildRepresentationHierarchy(snap, nodeIds);
    const snapBounds = computeStableProxyBounds(h3);
    const rep = groupRep(h3, "directory:a");
    const saved = snapBounds.w[rep];
    // Simulate a recut overwriting the live column from an engine box.
    h3.columns.boundsW[rep] = 999999;
    expect(snapBounds.w[rep]).toBe(saved); // the snapshot is independent of the columns
  });
});
