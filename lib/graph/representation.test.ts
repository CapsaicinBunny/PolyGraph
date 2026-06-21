import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  DETACHED_REP,
  isRepAncestor,
  type RepresentationHierarchy,
  representativeOf,
} from "./representation";
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
//   top-level {a,b}; a→{a/x,a/y}; b→{b/z}; top.c at the root (NO_GROUP).
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

/** Rep index of the group rep whose namespaced group id is `id`. */
function groupRep(h: RepresentationHierarchy, id: string): number {
  const ord = h.snapshot.groupIds.indexOf(id);
  if (ord === -1) throw new Error(`no group ${id}`);
  return h.repOfGroup[ord];
}
/** Leaf rep index of the node whose id is `nodeId`. */
function leafRep(h: RepresentationHierarchy, nodeId: string): number {
  return h.columns.leafRepresentationByNode[nodeIds.indexOf(nodeId)];
}

describe("buildRepresentationHierarchy — structure", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds);

  test("one rep per group plus one leaf rep per node", () => {
    // 5 groups (a, a/x, a/y, b, b/z) + 7 node leaf reps = 12 reps.
    expect(h.snapshot.groupIds.length).toBe(5);
    expect(h.repCount).toBe(5 + 7);
  });

  test("every node has a leaf representation, and it is a leaf (no children)", () => {
    for (const id of nodeIds) {
      const r = leafRep(h, id);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(h.columns.firstChildByRep[r]).toBe(-1);
    }
  });

  test("a leaf rep's parent is its node's direct group rep", () => {
    const f1 = leafRep(h, "a/x/f1.c");
    expect(h.columns.parentByRep[f1]).toBe(groupRep(h, "directory:a/x"));
  });

  test("a NO_GROUP node's leaf rep is a root (parent -1)", () => {
    const top = leafRep(h, "top.c");
    expect(h.columns.parentByRep[top]).toBe(-1);
    expect(h.roots).toContain(top);
  });

  test("group rep parent mirrors the grouping snapshot's parent", () => {
    expect(h.columns.parentByRep[groupRep(h, "directory:a/x")]).toBe(groupRep(h, "directory:a"));
    expect(h.columns.parentByRep[groupRep(h, "directory:a")]).toBe(-1); // a is a root group
    expect(h.roots).toContain(groupRep(h, "directory:a"));
  });

  test("sibling links enumerate every child exactly once", () => {
    // Walk a/x's children via firstChild/nextSibling — its two files.
    const ax = groupRep(h, "directory:a/x");
    const seen: number[] = [];
    let c = h.columns.firstChildByRep[ax];
    let guard = 100;
    while (c !== -1 && guard-- > 0) {
      seen.push(c);
      c = h.columns.nextSiblingByRep[c];
    }
    expect(seen.sort((a, b) => a - b)).toEqual(
      [leafRep(h, "a/x/f1.c"), leafRep(h, "a/x/f2.c")].sort((a, b) => a - b),
    );
  });

  test("a selected proxy renders as ONE aggregate card (rendered nodeCost = 1)", () => {
    // The per-LEVEL rendered cost of a proxy is one card, regardless of subtree size.
    expect(h.columns.nodeCost[groupRep(h, "directory:a")]).toBe(1);
    expect(h.columns.nodeCost[groupRep(h, "directory:b")]).toBe(1);
    // A leaf rep's rendered cost is its own node cost (1 by default).
    expect(h.columns.nodeCost[leafRep(h, "a/x/f1.c")]).toBe(1);
  });

  test("aggregated SUBTREE node cost rolls up to the proxy (a covers 3 files)", () => {
    // Each file costs 1 by default; a/x=2, a/y=1, a=3 — the FULL-OPEN size.
    expect(h.columns.subtreeNodeCost[groupRep(h, "directory:a")]).toBe(3);
    expect(h.columns.subtreeNodeCost[groupRep(h, "directory:a/x")]).toBe(2);
    expect(h.columns.subtreeNodeCost[groupRep(h, "directory:b")]).toBe(3);
  });

  test("custom per-node cost is summed into proxies' subtree cost", () => {
    const h2 = buildRepresentationHierarchy(snap, nodeIds, {
      nodeCost: (id) => (id === "a/x/f1.c" ? 10 : 1),
    });
    expect(h2.columns.subtreeNodeCost[groupRep(h2, "directory:a/x")]).toBe(11); // 10 + 1
    expect(h2.columns.subtreeNodeCost[groupRep(h2, "directory:a")]).toBe(12); // 11 + 1 (a/y)
  });
});

describe("buildRepresentationHierarchy — POST-FILTER visibility mask (Gap 7)", () => {
  // Hide the entire `b` subtree (f4, f5, f6) and one file in a/x (f2).
  const hidden = new Set(["b/z/f4.c", "b/z/f5.c", "b/z/f6.c", "a/x/f2.c"]);
  const h = buildRepresentationHierarchy(snap, nodeIds, {
    visibleNode: (ord) => !hidden.has(nodeIds[ord]),
  });

  test("a hidden leaf rep is DETACHED (parent -2, not a root, not a child)", () => {
    const f4 = leafRep(h, "b/z/f4.c");
    expect(h.columns.parentByRep[f4]).toBe(DETACHED_REP);
    expect(h.roots).not.toContain(f4);
    // It is no longer enumerated under its group.
    const bz = groupRep(h, "directory:b/z");
    const children: number[] = [];
    let c = h.columns.firstChildByRep[bz];
    let guard = 100;
    while (c !== -1 && guard-- > 0) {
      children.push(c);
      c = h.columns.nextSiblingByRep[c];
    }
    expect(children).not.toContain(f4);
  });

  test("a group with NO visible members is DETACHED and carries zero cost", () => {
    const b = groupRep(h, "directory:b");
    const bz = groupRep(h, "directory:b/z");
    expect(h.columns.parentByRep[b]).toBe(DETACHED_REP);
    expect(h.columns.parentByRep[bz]).toBe(DETACHED_REP);
    expect(h.roots).not.toContain(b);
    // No phantom card cost from a fully-hidden group.
    expect(h.columns.nodeCost[b]).toBe(0);
    expect(h.columns.subtreeNodeCost[b]).toBe(0);
  });

  test("a partially-hidden group keeps a proxy, but only visible leaves roll up", () => {
    const ax = groupRep(h, "directory:a/x");
    const a = groupRep(h, "directory:a");
    // a/x had {f1, f2}; f2 hidden → only f1 (cost 1) contributes.
    expect(h.columns.subtreeNodeCost[ax]).toBe(1);
    // a = a/x(1 visible) + a/y(f3, 1) = 2 (was 3 unfiltered).
    expect(h.columns.subtreeNodeCost[a]).toBe(2);
    // The visible proxy still renders as one card.
    expect(h.columns.nodeCost[ax]).toBe(1);
    expect(h.roots).toContain(a);
  });

  test("a hidden leaf has no representative among ATTACHED reps (walk stops at -2)", () => {
    // A detached leaf's path to the root is severed at -2, so no ATTACHED ancestor (the only
    // reps the cut ever selects) can represent it. Selecting every group rep proves it: the
    // hidden leaf still resolves to nothing.
    const f4Ord = nodeIds.indexOf("b/z/f4.c");
    const groupReps = new Set(
      Array.from({ length: snap.groupIds.length }, (_, g) => h.repOfGroup[g]),
    );
    expect(representativeOf(h, f4Ord, (r) => groupReps.has(r))).toBe(-1);
    // A visible node still resolves to its selected ancestor proxy.
    const f1Ord = nodeIds.indexOf("a/x/f1.c");
    const ax = groupRep(h, "directory:a/x");
    expect(representativeOf(h, f1Ord, (r) => r === ax)).toBe(ax);
  });

  test("an unmasked build is unchanged (empty/visible groups still kept as before)", () => {
    const plain = buildRepresentationHierarchy(snap, nodeIds);
    // Every group rep is attached (no DETACHED_REP) when no mask is supplied.
    for (let g = 0; g < snap.groupIds.length; g++) {
      expect(plain.columns.parentByRep[plain.repOfGroup[g]]).not.toBe(DETACHED_REP);
    }
    expect(plain.columns.subtreeNodeCost[groupRep(plain, "directory:b")]).toBe(3);
  });
});

describe("DFS intervals — isRepAncestor O(1)", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds);

  test("a proxy is an ancestor of its descendants and of itself", () => {
    const a = groupRep(h, "directory:a");
    const ax = groupRep(h, "directory:a/x");
    const f1 = leafRep(h, "a/x/f1.c");
    expect(isRepAncestor(h.columns, a, ax)).toBe(true);
    expect(isRepAncestor(h.columns, a, f1)).toBe(true);
    expect(isRepAncestor(h.columns, ax, f1)).toBe(true);
    expect(isRepAncestor(h.columns, a, a)).toBe(true); // reflexive
  });

  test("non-ancestors are rejected", () => {
    const a = groupRep(h, "directory:a");
    const b = groupRep(h, "directory:b");
    const f4 = leafRep(h, "b/z/f4.c");
    expect(isRepAncestor(h.columns, a, b)).toBe(false);
    expect(isRepAncestor(h.columns, a, f4)).toBe(false);
    expect(isRepAncestor(h.columns, b, a)).toBe(false);
    // A leaf is never an ancestor of a proxy.
    expect(isRepAncestor(h.columns, f4, b)).toBe(false);
  });

  test("entry/exit nest: a child's interval is inside its parent's", () => {
    const a = groupRep(h, "directory:a");
    const ax = groupRep(h, "directory:a/x");
    expect(h.columns.entryByRep[a]).toBeLessThanOrEqual(h.columns.entryByRep[ax]);
    expect(h.columns.exitByRep[ax]).toBeLessThanOrEqual(h.columns.exitByRep[a]);
  });
});

describe("representativeOf — walk leaf → first selected ancestor", () => {
  const h = buildRepresentationHierarchy(snap, nodeIds);
  const a = groupRep(h, "directory:a");
  const ax = groupRep(h, "directory:a/x");
  const f1Ord = nodeIds.indexOf("a/x/f1.c");
  const f1Leaf = leafRep(h, "a/x/f1.c");

  test("when the leaf itself is selected, it represents the node", () => {
    const selected = new Set([f1Leaf]);
    expect(representativeOf(h, f1Ord, (r) => selected.has(r))).toBe(f1Leaf);
  });

  test("when an ancestor proxy is selected, it stands in for the node", () => {
    const selected = new Set([a]);
    expect(representativeOf(h, f1Ord, (r) => selected.has(r))).toBe(a);
  });

  test("the NEAREST selected ancestor wins (deepest selected on the path)", () => {
    const selected = new Set([a, ax]);
    expect(representativeOf(h, f1Ord, (r) => selected.has(r))).toBe(ax);
  });

  test("no selected ancestor → -1 (caller treats as not represented)", () => {
    expect(representativeOf(h, f1Ord, () => false)).toBe(-1);
  });
});
