import { describe, expect, test } from "bun:test";
import type { ClusterBox } from "../layout";
import { smartLayout } from "./smart";

const N = (id: string, kind = "file") => ({ id, kind });
const SYMN = (id: string) => ({ id, kind: "function" });
const E = (source: string, target: string) => ({ source, target });

// Two packages (pkg: a→b) and a standalone util file.
const view = {
  nodes: [N("pkg/a.ts"), N("pkg/b.ts"), N("util/c.ts")],
  edges: [{ source: "pkg/a.ts", target: "pkg/b.ts" }],
};

function boxOf(clusters: ClusterBox[], id: string): ClusterBox {
  const b = clusters.find((c) => c.id === id);
  if (!b) throw new Error(`no cluster ${id}`);
  return b;
}
const overlaps = (p: ClusterBox, q: ClusterBox) =>
  p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;

describe("smartLayout", () => {
  test("emits a box per top-level directory", () => {
    const { clusters } = smartLayout(view, { direction: "LR" });
    expect(clusters.map((c) => c.id).sort()).toEqual(["pkg", "util"]);
    expect(boxOf(clusters, "pkg").depth).toBe(0);
  });

  test("every node sits inside its cluster box", () => {
    const { nodes, clusters } = smartLayout(view, { direction: "LR" });
    const pkg = boxOf(clusters, "pkg");
    for (const id of ["pkg/a.ts", "pkg/b.ts"]) {
      const p = nodes.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(pkg.x);
      expect(p.y).toBeGreaterThanOrEqual(pkg.y);
      expect(p.x).toBeLessThanOrEqual(pkg.x + pkg.width);
      expect(p.y).toBeLessThanOrEqual(pkg.y + pkg.height);
    }
  });

  test("sibling boxes do not overlap", () => {
    const { clusters } = smartLayout(view, { direction: "LR" });
    expect(overlaps(boxOf(clusters, "pkg"), boxOf(clusters, "util"))).toBe(false);
  });

  test("is deterministic", () => {
    const a = smartLayout(view, { direction: "TB" });
    const b = smartLayout(view, { direction: "TB" });
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
    expect(a.clusters).toEqual(b.clusters);
  });

  test("handles an empty graph", () => {
    const r = smartLayout({ nodes: [], edges: [] }, {});
    expect(r.nodes.size).toBe(0);
    expect(r.clusters).toEqual([]);
  });
});

const SYM = { width: 170, height: 44 }; // SYMBOL_SIZE for non-file kinds
const within = (p: { x: number; y: number }, b: ClusterBox, w = 0, h = 0) =>
  p.x >= b.x && p.y >= b.y && p.x + w <= b.x + b.width && p.y + h <= b.y + b.height;

describe("smartLayout adaptive (Phase B)", () => {
  test("a cyclic cluster keeps every node inside its box (SCC ring)", () => {
    const cyc = {
      nodes: [SYMN("pkg/x.ts#x"), SYMN("pkg/y.ts#y"), SYMN("pkg/z.ts#z")],
      edges: [
        E("pkg/x.ts#x", "pkg/y.ts#y"),
        E("pkg/y.ts#y", "pkg/z.ts#z"),
        E("pkg/z.ts#z", "pkg/x.ts#x"),
      ],
    };
    const { nodes, clusters } = smartLayout(cyc, { direction: "LR" });
    const pkg = boxOf(clusters, "pkg");
    for (const id of ["pkg/x.ts#x", "pkg/y.ts#y", "pkg/z.ts#z"]) {
      expect(within(nodes.get(id)!, pkg, SYM.width, SYM.height)).toBe(true);
    }
    const again = smartLayout(cyc, { direction: "LR" });
    expect([...nodes.entries()]).toEqual([...again.nodes.entries()]);
  });

  test("an edgeless cluster grid-places its files without overlaps", () => {
    const flat = {
      nodes: [N("g/a.ts"), N("g/b.ts"), N("g/c.ts"), N("g/d.ts")],
      edges: [] as { source: string; target: string }[],
    };
    const { nodes } = smartLayout(flat, { direction: "TB" });
    const ids = ["g/a.ts", "g/b.ts", "g/c.ts", "g/d.ts"];
    const FILE = { w: 200, h: 56 };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = nodes.get(ids[i])!;
        const q = nodes.get(ids[j])!;
        const overlap =
          p.x < q.x + FILE.w && q.x < p.x + FILE.w && p.y < q.y + FILE.h && q.y < p.y + FILE.h;
        expect(overlap).toBe(false);
      }
    }
  });

  test("a dense acyclic cluster (force) keeps nodes inside its box and is deterministic", () => {
    const ids = ["d/a.ts", "d/b.ts", "d/c.ts", "d/e.ts", "d/f.ts"];
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (!(i === 3 && j === 4)) edges.push(E(ids[i], ids[j]));
    // 9 forward (acyclic) edges over 5 items → m(9) > n(5)*1.6 → force mode.
    const dense = { nodes: ids.map((id) => N(id)), edges };
    const a = smartLayout(dense, { direction: "LR" });
    const box = boxOf(a.clusters, "d");
    for (const id of ids) expect(within(a.nodes.get(id)!, box, 200, 56)).toBe(true);
    const b = smartLayout(dense, { direction: "LR" });
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
  });
});
