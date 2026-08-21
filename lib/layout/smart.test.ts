import { describe, expect, test } from "bun:test";
import { type ClusterBox, resolveEngineForBudget } from "../layout";
import { aggregateInternalEdges, smartLayout } from "./smart";

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

  test("Smart + Directory keys each ClusterBox by its directory path (LOD contract)", () => {
    // The adaptive LOD cut measures one box per directory, keyed by the dir path
    // (buildClusterTree path === sceneBoxes key === DirNode.path). Breaking this
    // self-disables the cut, so keep it asserted.
    const { clusters } = smartLayout(view, { groupBy: "directory", direction: "LR" });
    const ids = new Set(clusters.map((c) => c.id));
    expect(ids.has("pkg")).toBe(true);
    expect(ids.has("util")).toBe(true);
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

  test("a cross-directory cycle rings the child-cluster boxes without overlap", () => {
    // dirA/x ⇄ dirB/y — at the root, items "dirA" and "dirB" form a 2-cycle, so
    // they become a ring of child-cluster boxes (the trickiest expansion path).
    const cross = {
      nodes: [N("dirA/x.ts"), N("dirB/y.ts")],
      edges: [E("dirA/x.ts", "dirB/y.ts"), E("dirB/y.ts", "dirA/x.ts")],
    };
    const { nodes, clusters } = smartLayout(cross, { direction: "LR" });
    const a = boxOf(clusters, "dirA");
    const b = boxOf(clusters, "dirB");
    expect(overlaps(a, b)).toBe(false);
    expect(within(nodes.get("dirA/x.ts")!, a, 200, 56)).toBe(true);
    expect(within(nodes.get("dirB/y.ts")!, b, 200, 56)).toBe(true);
    const again = smartLayout(cross, { direction: "LR" });
    expect([...nodes.entries()]).toEqual([...again.nodes.entries()]);
    expect(clusters).toEqual(again.clusters);
  });

  test("density widens (sparse) or tightens (dense) the layout", () => {
    const sparse = smartLayout(view, { direction: "LR", density: 1.6 });
    const dense = smartLayout(view, { direction: "LR", density: 0.6 });
    // The 'pkg' box (with internal padding scaled by density) is larger when sparser.
    expect(boxOf(sparse.clusters, "pkg").width).toBeGreaterThan(boxOf(dense.clusters, "pkg").width);
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

describe("grouped Smart runs the shape planner per leaf cluster", () => {
  const dir = (view: {
    nodes: { id: string; kind: string }[];
    edges: { source: string; target: string }[];
  }) => smartLayout(view, { groupBy: "directory", direction: "LR" });
  // The planner's heuristic pick for a shape (candidate scoring may then refine the actual
  // engine for medium clusters — see the candidate-scoring test below).
  const engineOf = (clusters: ClusterBox[], id: string) =>
    clusters.find((c) => c.id === id)?.requestedEngine;

  test("edgeless leaf cluster → grid", () => {
    const { clusters } = dir({ nodes: [N("g/a.ts"), N("g/b.ts"), N("g/c.ts")], edges: [] });
    expect(engineOf(clusters, "g")).toBe("grid");
  });

  test("rooted-tree leaf cluster → tree", () => {
    const { clusters } = dir({
      nodes: ["t/r.ts", "t/a.ts", "t/b.ts", "t/c.ts"].map((id) => N(id)),
      edges: [E("t/r.ts", "t/a.ts"), E("t/r.ts", "t/b.ts"), E("t/a.ts", "t/c.ts")],
    });
    expect(engineOf(clusters, "t")).toBe("tree");
  });

  test("acyclic merge (DAG) leaf cluster → layered", () => {
    const { clusters } = dir({
      nodes: ["d/a.ts", "d/b.ts", "d/c.ts", "d/e.ts"].map((id) => N(id)),
      edges: [
        E("d/a.ts", "d/b.ts"),
        E("d/a.ts", "d/c.ts"),
        E("d/b.ts", "d/e.ts"),
        E("d/c.ts", "d/e.ts"),
      ],
    });
    expect(engineOf(clusters, "d")).toBe("layered");
  });

  test("small cyclic leaf cluster → circular", () => {
    const { clusters } = dir({
      nodes: ["c/x.ts", "c/y.ts", "c/z.ts"].map((id) => N(id)),
      edges: [E("c/x.ts", "c/y.ts"), E("c/y.ts", "c/z.ts"), E("c/z.ts", "c/x.ts")],
    });
    expect(engineOf(clusters, "c")).toBe("circular");
  });

  test("hub-with-many-leaves leaf cluster → backbone", () => {
    const edges = [E("h/a.ts", "h/b.ts"), E("h/b.ts", "h/c.ts"), E("h/c.ts", "h/a.ts")];
    for (const leaf of ["d", "e", "f", "g", "i"]) edges.push(E("h/a.ts", `h/${leaf}.ts`));
    const nodes = ["a", "b", "c", "d", "e", "f", "g", "i"].map((s) => N(`h/${s}.ts`));
    expect(engineOf(dir({ nodes, edges }).clusters, "h")).toBe("backbone");
  });

  test("large cyclic leaf cluster → stress", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `s/n${i}.ts`);
    const edges = ids.map((id, i) => E(id, ids[(i + 1) % ids.length]));
    expect(engineOf(dir({ nodes: ids.map((id) => N(id)), edges }).clusters, "s")).toBe("stress");
  });

  test("oversized leaf cluster → guarded backbone fallback (records requested + reason)", () => {
    // A multi-parent DAG of >1200 nodes: the planner asks for layered; the budget guard
    // downgrades it to the STRUCTURAL backbone (still within backbone's 2500 cap), not the
    // meaningless alphabetical grid, and records why.
    const n = 1250;
    const nodes = Array.from({ length: n }, (_, i) => N(`big/n${i}.ts`));
    const edges: { source: string; target: string }[] = [];
    for (let i = 2; i < n; i++) {
      edges.push(E(`big/n${i - 1}.ts`, `big/n${i}.ts`));
      edges.push(E(`big/n${i - 2}.ts`, `big/n${i}.ts`));
    }
    const box = dir({ nodes, edges }).clusters.find((c) => c.id === "big")!;
    expect(box.requestedEngine).toBe("layered");
    expect(box.engine).toBe("backbone");
    expect(box.fallbackReason).toBe("node-cap");
  });

  test("selects different engines for different-shaped dirs in one repo", () => {
    const { clusters } = dir({
      nodes: [
        ...["t/r.ts", "t/a.ts", "t/b.ts"].map((id) => N(id)),
        ...["c/x.ts", "c/y.ts", "c/z.ts"].map((id) => N(id)),
        ...["g/a.ts", "g/b.ts"].map((id) => N(id)),
        ...["d/a.ts", "d/b.ts", "d/c.ts", "d/e.ts"].map((id) => N(id)),
      ],
      edges: [
        E("t/r.ts", "t/a.ts"),
        E("t/r.ts", "t/b.ts"),
        E("c/x.ts", "c/y.ts"),
        E("c/y.ts", "c/z.ts"),
        E("c/z.ts", "c/x.ts"),
        E("d/a.ts", "d/b.ts"),
        E("d/a.ts", "d/c.ts"),
        E("d/b.ts", "d/e.ts"),
        E("d/c.ts", "d/e.ts"),
      ],
    });
    expect(engineOf(clusters, "t")).toBe("tree");
    expect(engineOf(clusters, "c")).toBe("circular");
    expect(engineOf(clusters, "g")).toBe("grid");
    expect(engineOf(clusters, "d")).toBe("layered");
    // The whole point: one repo, several different engines selected.
    expect(
      new Set(["t", "c", "g", "d"].map((id) => engineOf(clusters, id))).size,
    ).toBeGreaterThanOrEqual(3);
  });

  test("every directory box keeps its directory-path id + is deterministic (LOD contract)", () => {
    const view = {
      nodes: [
        ...["t/r.ts", "t/a.ts"].map((id) => N(id)),
        ...["c/x.ts", "c/y.ts", "c/z.ts"].map((id) => N(id)),
      ],
      edges: [
        E("t/r.ts", "t/a.ts"),
        E("c/x.ts", "c/y.ts"),
        E("c/y.ts", "c/z.ts"),
        E("c/z.ts", "c/x.ts"),
      ],
    };
    const a = dir(view);
    const b = dir(view);
    expect(a.clusters.map((c) => c.id).sort()).toEqual(["c", "t"]);
    expect(a.clusters).toEqual(b.clusters);
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
  });

  test("candidate scoring refines the actual engine (medium cluster), deterministically", () => {
    // A 70-node cycle is in the scoring band: the planner REQUESTS stress, then scoring runs
    // the candidates and keeps the lowest-crossing one — recorded as the actual engine.
    const ids = Array.from({ length: 70 }, (_, i) => `sc/n${i}.ts`);
    const edges = ids.map((id, i) => E(id, ids[(i + 1) % ids.length]));
    const box = dir({ nodes: ids.map((id) => N(id)), edges }).clusters.find((c) => c.id === "sc")!;
    expect(box.requestedEngine).toBe("stress"); // the planner's heuristic pick
    expect(box.engine && ["stress", "force", "layered"].includes(box.engine)).toBe(true); // scored candidate
    const again = dir({ nodes: ids.map((id) => N(id)), edges }).clusters.find(
      (c) => c.id === "sc",
    )!;
    expect(again.engine).toBe(box.engine); // deterministic
  });

  test("scoring keeps Layered for a clean DAG (flow term + hysteresis, no Force takeover)", () => {
    // A 4-level DAG (16 nodes, in the scoring band). Force/Stress might cut a crossing, but
    // they scramble the dependency flow — the backward-edge term + the hysteresis margin keep
    // the planner's Layered pick.
    const lv = [0, 1, 2, 3].map((l) => [0, 1, 2, 3].map((i) => `flow/l${l}n${i}`));
    const edges: { source: string; target: string }[] = [];
    for (let l = 0; l < 3; l++)
      for (let i = 0; i < 4; i++) {
        edges.push(E(lv[l][i], lv[l + 1][i]));
        edges.push(E(lv[l][i], lv[l + 1][(i + 1) % 4]));
      }
    const box = dir({ nodes: lv.flat().map((id) => N(id)), edges }).clusters.find(
      (c) => c.id === "flow",
    )!;
    expect(box.requestedEngine).toBe("layered");
    expect(box.engine).toBe("layered"); // scoring did NOT override the DAG's flow
  });

  test("accepts + threads previousPositions into leaf clusters (deterministic with a seed)", () => {
    // Plumbing check: grouped Smart takes previousPositions and passes it to the seeding
    // engines (force/dense-stress) inside leaf clusters. (Engine seeding itself is covered in
    // layout.test.ts.) Must stay deterministic with the seed.
    const v = {
      nodes: ["p/a.ts", "p/b.ts", "p/c.ts", "p/d.ts"].map((id) => N(id)),
      edges: [E("p/a.ts", "p/b.ts"), E("p/b.ts", "p/c.ts"), E("p/c.ts", "p/d.ts")],
    };
    const previousPositions = new Map([
      ["p/a.ts", { x: 0, y: 0 }],
      ["p/b.ts", { x: 400, y: 0 }],
    ]);
    const a = smartLayout(v, { groupBy: "directory", previousPositions });
    const b = smartLayout(v, { groupBy: "directory", previousPositions });
    expect(a.nodes.size).toBe(4);
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
  });

  test("dense leaf cluster skips O(E²) candidate scoring (lays out fast + deterministically)", () => {
    // 70 nodes, ~2100 edges (> SCORE_MAX_EDGES), cyclic → stress primary. The edge gate keeps
    // it on the single planner pick; without it, scoring would also run the layered candidate
    // (dagre blows up on dense graphs). Completes quickly because scoring is skipped.
    const n = 70;
    const ids = Array.from({ length: n }, (_, i) => `d/n${i}.ts`);
    const edges: { source: string; target: string }[] = [];
    for (let i = 0; i < n; i++)
      for (let k = 1; k <= 30; k++) edges.push(E(ids[i], ids[(i + k) % n])); // dense + cyclic
    const a = dir({ nodes: ids.map((id) => N(id)), edges });
    expect(a.nodes.size).toBe(n);
    const b = dir({ nodes: ids.map((id) => N(id)), edges });
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]); // deterministic
  });

  test("container placement ranks subsystem boxes by their dependency flow", () => {
    // dirA → dirB → dirC at the file level → the top-level boxes form a DAG, so the container
    // planner arranges them with dagre (ranked), not the old size heuristic. LR → A left of C.
    const { clusters } = dir({
      nodes: ["dirA/x.ts", "dirB/y.ts", "dirC/z.ts"].map((id) => N(id)),
      edges: [E("dirA/x.ts", "dirB/y.ts"), E("dirB/y.ts", "dirC/z.ts")],
    });
    const x = (id: string) => clusters.find((c) => c.id === id)!.x;
    expect(x("dirA")).toBeLessThan(x("dirB"));
    expect(x("dirB")).toBeLessThan(x("dirC"));
  });
});

describe("resolveEngineForBudget (budget guard, separate from chooseEngine)", () => {
  test("passes an engine through under its cap", () => {
    expect(resolveEngineForBudget("tree", 100, 50)).toEqual({
      engine: "tree",
      fallbackReason: null,
    });
  });
  test("downgrades to backbone over the node cap; grid only when too big for backbone", () => {
    // Just over layered's 1200 cap but within backbone's 2500 → structural backbone.
    expect(resolveEngineForBudget("layered", 1201, 10)).toEqual({
      engine: "backbone",
      fallbackReason: "node-cap",
    });
    // Over backbone's own cap → the cheap grid.
    expect(resolveEngineForBudget("layered", 2501, 10)).toEqual({
      engine: "grid",
      fallbackReason: "node-cap",
    });
  });
  test("downgrades to grid over the edge cap (but stress is exempt — near-linear)", () => {
    expect(resolveEngineForBudget("layered", 100, 8001)).toEqual({
      engine: "grid",
      fallbackReason: "edge-cap",
    });
    // Stress uses PivotMDS for large/dense comps, so a high edge count keeps it running.
    expect(resolveEngineForBudget("stress", 100, 8001)).toEqual({
      engine: "stress",
      fallbackReason: null,
    });
  });
  test("uncapped engines (grid/circular/radial) always pass through", () => {
    expect(resolveEngineForBudget("circular", 99999, 99999)).toEqual({
      engine: "circular",
      fallbackReason: null,
    });
  });
});

describe("aggregateInternalEdges (weighted relationship aggregation)", () => {
  test("sums weight + count of parallel edges and keeps the heaviest kind", () => {
    const edges = [
      { source: "A", target: "B", kind: "call" as const, count: 3, weight: 1 },
      { source: "A", target: "B", kind: "extends" as const, count: 1, weight: 8 },
      { source: "C", target: "D", kind: "call" as const, count: 1, weight: 1 },
      { source: "A", target: "Z", kind: "call" as const, count: 1, weight: 1 }, // Z not in set
    ];
    expect(aggregateInternalEdges(edges, new Set(["A", "B", "C", "D"]))).toEqual([
      { source: "A", target: "B", kind: "extends", count: 4, weight: 9 },
      { source: "C", target: "D", kind: "call", count: 1, weight: 1 },
    ]);
  });
});
