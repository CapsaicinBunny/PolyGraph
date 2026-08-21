import { describe, expect, test } from "bun:test";
import {
  buildClusterTree,
  buildClusterTreeFromSnapshot,
  type ClusterTreeNode,
  snapshotFromClusterTree,
} from "./clusters";

const N = (id: string, kind = "file") => ({ id, kind });

/** Deep, order-independent structural comparison of two cluster trees. */
function sameTree(a: ClusterTreeNode, b: ClusterTreeNode): void {
  expect(a.id).toBe(b.id);
  expect(a.label).toBe(b.label);
  expect([...a.nodeIds].sort()).toEqual([...b.nodeIds].sort());
  expect([...a.children.keys()].sort()).toEqual([...b.children.keys()].sort());
  for (const key of a.children.keys()) {
    sameTree(a.children.get(key)!, b.children.get(key)!);
  }
}

// A representative directory-ish layout node set: nested dirs, a compressible chain,
// symbols (carry "#"), an external node, and a repo-root file.
const nodes = [
  N("a/b/f.ts"),
  N("a/b/f.ts#x", "function"),
  N("a/c/g.ts"),
  N("src/lib/graph/x.ts"),
  N("react", "external"),
  N("README.md"),
];

describe("snapshotFromClusterTree → buildClusterTreeFromSnapshot round-trips byte-identically", () => {
  test("the rebuilt directory tree equals buildClusterTree (the byte-identity contract)", () => {
    const built = buildClusterTree(nodes);
    const snap = snapshotFromClusterTree(built, nodes, "directory");
    const rebuilt = buildClusterTreeFromSnapshot(nodes, snap);
    sameTree(rebuilt.root, built.root);
  });

  test("ancestry survives the round-trip exactly (the chain itemOf() walks)", () => {
    const built = buildClusterTree(nodes);
    const snap = snapshotFromClusterTree(built, nodes, "directory");
    const rebuilt = buildClusterTreeFromSnapshot(nodes, snap);
    for (const id of nodes.map((n) => n.id)) {
      expect(rebuilt.ancestry.get(id)).toEqual(built.ancestry.get(id));
    }
  });

  test("the compressed single-child chain (src/lib/graph) is preserved as ONE box", () => {
    const built = buildClusterTree(nodes);
    const snap = snapshotFromClusterTree(built, nodes, "directory");
    const rebuilt = buildClusterTreeFromSnapshot(nodes, snap);
    const top = rebuilt.root.children.get("src")!;
    expect(top.id).toBe("src/lib/graph");
    expect(top.label).toBe("src/lib/graph");
    expect(top.nodeIds).toEqual(["src/lib/graph/x.ts"]);
  });

  test("repo-root files land at the root (no box); externals under the synthetic dir", () => {
    const built = buildClusterTree(nodes);
    const snap = snapshotFromClusterTree(built, nodes, "directory");
    const rebuilt = buildClusterTreeFromSnapshot(nodes, snap);
    expect(rebuilt.root.nodeIds).toContain("README.md"); // root member
    expect(rebuilt.root.children.get("«external»")!.nodeIds).toEqual(["react"]);
  });

  test("a flat (community-style) grouping round-trips with one box per group", () => {
    // Each node groups by a synthetic single-level key; boxKey ≠ joined-label path.
    const flat = [N("a.ts"), N("b.ts"), N("c.ts")];
    const groupOf = (n: { id: string }) => (n.id === "c.ts" ? [] : ["G1"]);
    const built = buildClusterTree(flat, groupOf);
    const snap = snapshotFromClusterTree(built, flat, "community");
    const rebuilt = buildClusterTreeFromSnapshot(flat, snap);
    sameTree(rebuilt.root, built.root);
    expect(rebuilt.root.children.get("G1")!.nodeIds.sort()).toEqual(["a.ts", "b.ts"]);
    expect(rebuilt.root.nodeIds).toEqual(["c.ts"]); // ungrouped → root
  });

  test("an empty node set yields an empty snapshot + a bare root", () => {
    const built = buildClusterTree([]);
    const snap = snapshotFromClusterTree(built, [], "directory");
    expect(snap.groupIds).toEqual([]);
    const rebuilt = buildClusterTreeFromSnapshot([], snap);
    expect(rebuilt.root.children.size).toBe(0);
    expect(rebuilt.root.nodeIds).toEqual([]);
  });

  test("the snapshot's boxKeyByGroup is the cluster box id (LOD/layout agreement)", () => {
    const built = buildClusterTree(nodes);
    const snap = snapshotFromClusterTree(built, nodes, "directory");
    // Every group's boxKey must equal a real ClusterBox id the layout emits.
    const boxIds = new Set<string>();
    const walk = (node: ClusterTreeNode) => {
      if (node.id !== "") boxIds.add(node.id);
      for (const c of node.children.values()) walk(c);
    };
    walk(built.root);
    for (const boxKey of snap.boxKeyByGroup) expect(boxIds.has(boxKey)).toBe(true);
  });
});
