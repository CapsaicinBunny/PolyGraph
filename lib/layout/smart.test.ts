import { describe, expect, test } from "bun:test";
import type { ClusterBox } from "../layout";
import { smartLayout } from "./smart";

const N = (id: string, kind = "file") => ({ id, kind });

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
