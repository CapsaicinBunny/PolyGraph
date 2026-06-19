import { describe, expect, test } from "bun:test";
import type { GraphView } from "./aggregate";
import { type LayoutAlgorithm, type LayoutInput, layoutView, runLayout } from "./layout";
import { edgeWeight } from "./layout/weight";

// A → B, so the layout should place B "after" A along the flow axis.
const view: GraphView = {
  nodes: [
    { id: "a", kind: "file", label: "a", filePath: "a", line: 0, parentFile: "a" },
    { id: "b", kind: "file", label: "b", filePath: "b", line: 0, parentFile: "b" },
  ],
  edges: [
    {
      id: "a->b:import",
      source: "a",
      target: "b",
      kind: "import",
      occurrences: [],
      count: 0,
      originalEdgeIds: [],
    },
  ],
};

describe("layoutView direction", () => {
  test("LR lays the edge out horizontally", () => {
    const pos = layoutView(view, { direction: "LR" });
    const a = pos.get("a")!;
    const b = pos.get("b")!;
    expect(b.x).toBeGreaterThan(a.x);
    expect(Math.abs(b.y - a.y)).toBeLessThan(Math.abs(b.x - a.x));
  });

  test("TB lays the edge out vertically with B below A", () => {
    const pos = layoutView(view, { direction: "TB" });
    const a = pos.get("a")!;
    const b = pos.get("b")!;
    expect(b.y).toBeGreaterThan(a.y);
    expect(Math.abs(b.x - a.x)).toBeLessThan(Math.abs(b.y - a.y));
  });

  test("BT places B above A", () => {
    const pos = layoutView(view, { direction: "BT" });
    expect(pos.get("b")!.y).toBeLessThan(pos.get("a")!.y);
  });

  test("every node gets a position", () => {
    const pos = layoutView(view);
    expect(pos.size).toBe(2);
  });
});

describe("layout algorithms", () => {
  const bigger: GraphView = {
    nodes: ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      kind: "file" as const,
      label: id,
      filePath: id,
      line: 0,
      parentFile: id,
    })),
    edges: [
      {
        id: "a->b:import",
        source: "a",
        target: "b",
        kind: "import",
        occurrences: [],
        count: 0,
        originalEdgeIds: [],
      },
      {
        id: "a->c:import",
        source: "a",
        target: "c",
        kind: "import",
        occurrences: [],
        count: 0,
        originalEdgeIds: [],
      },
      {
        id: "b->d:import",
        source: "b",
        target: "d",
        kind: "import",
        occurrences: [],
        count: 0,
        originalEdgeIds: [],
      },
    ],
  };

  const algorithms: LayoutAlgorithm[] = ["layered", "tree", "radial", "circular", "grid", "force"];

  for (const algorithm of algorithms) {
    test(`${algorithm}: positions every node and spreads them out`, () => {
      const pos = layoutView(bigger, { algorithm });
      expect(pos.size).toBe(bigger.nodes.length);
      // Positions must not all collapse onto one point.
      const unique = new Set([...pos.values()].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
      expect(unique.size).toBe(bigger.nodes.length);
    });
  }

  test("force layout is deterministic across runs", () => {
    const a = layoutView(bigger, { algorithm: "force" });
    const b = layoutView(bigger, { algorithm: "force" });
    for (const id of a.keys()) {
      expect(b.get(id)).toEqual(a.get(id));
    }
  });
});

describe("previousPositions seeding (mental-map stability)", () => {
  const two: GraphView = {
    nodes: [
      { id: "a", kind: "file", label: "a", filePath: "a", line: 0, parentFile: "a" },
      { id: "b", kind: "file", label: "b", filePath: "b", line: 0, parentFile: "b" },
    ],
    edges: [],
  };

  test("force seeds from previous positions instead of the default arrangement", () => {
    // d3-force's default index arrangement places node a to the RIGHT of node b.
    // Seeding a to the left and b to the right must flip that — proving the seed
    // (and thus mental-map preservation across re-layouts) actually takes effect.
    const previousPositions = new Map([
      ["a", { x: -600, y: 0 }],
      ["b", { x: 600, y: 0 }],
    ]);
    const pos = layoutView(two, { algorithm: "force", previousPositions });
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  });
});

describe("stable component packing", () => {
  // Two isolated components (singletons have no internal-ordering ambiguity, so this
  // isolates the packing order from the per-engine node order).
  const node = (id: string): GraphView["nodes"][number] => ({
    id,
    kind: "file",
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
  });

  test("component placement is independent of input node order (stable packing)", () => {
    // Old packing followed connected-component discovery order, which depends on node
    // input order, so reordering nodes reshuffled the canvas. Stable packing sorts
    // components by min id, so the same graph lays out identically either way.
    const a = layoutView({ nodes: [node("a"), node("z")], edges: [] }, { algorithm: "circular" });
    const b = layoutView({ nodes: [node("z"), node("a")], edges: [] }, { algorithm: "circular" });
    expect(a.get("a")).toEqual(b.get("a"));
    expect(a.get("z")).toEqual(b.get("z"));
  });
});

describe("circular layout is graph-aware (not input order)", () => {
  // A 4-cycle given in SCRAMBLED input order. A graph-aware ring must place
  // graph-adjacent nodes at adjacent angles regardless of input order.
  const cycle: GraphView = {
    nodes: ["a", "c", "b", "d"].map((id) => ({
      id,
      kind: "file" as const,
      label: id,
      filePath: id,
      line: 0,
      parentFile: id,
    })),
    edges: ["a:b", "b:c", "c:d", "d:a"].map((p) => {
      const [s, t] = p.split(":");
      return { id: `${s}->${t}:import`, source: s, target: t, kind: "import" as const, occurrences: [], count: 1, originalEdgeIds: [] };
    }),
  };

  test("consecutive nodes on the ring are graph-adjacent", () => {
    const pos = layoutView(cycle, { algorithm: "circular" });
    const adjacent = new Set(["a-b", "b-a", "b-c", "c-b", "c-d", "d-c", "d-a", "a-d"]);
    const byAngle = ["a", "b", "c", "d"]
      .map((id) => {
        const p = pos.get(id)!;
        return { id, angle: Math.atan2(p.y + 28, p.x + 100) };
      })
      .sort((u, v) => u.angle - v.angle)
      .map((u) => u.id);
    for (let i = 0; i < byAngle.length; i++) {
      const a = byAngle[i];
      const b = byAngle[(i + 1) % byAngle.length];
      expect(adjacent.has(`${a}-${b}`)).toBe(true);
    }
  });
});

describe("grid layout is ordered (not input order)", () => {
  const mk = (id: string): GraphView["nodes"][number] => ({
    id,
    kind: "file" as const,
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
  });

  test("fills the grid in directory-grouped order regardless of input order", () => {
    const g: GraphView = { nodes: ["b/2", "a/1", "b/1", "a/2"].map(mk), edges: [] };
    const pos = layoutView(g, { algorithm: "grid" });
    // Read the grid back in row-major (top-to-bottom, left-to-right) order.
    const rowMajor = ["a/1", "a/2", "b/1", "b/2"]
      .map((id) => ({ id, p: pos.get(id)! }))
      .sort((u, v) => u.p.y - v.p.y || u.p.x - v.p.x)
      .map((u) => u.id);
    // Directory-grouped: a/* before b/*, path order within.
    expect(rowMajor).toEqual(["a/1", "a/2", "b/1", "b/2"]);
  });
});

describe("radial layout is graph-aware (directed rings + stable)", () => {
  const mk = (id: string): GraphView["nodes"][number] => ({
    id,
    kind: "file" as const,
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
  });
  const ed = (s: string, t: string) => ({
    id: `${s}->${t}:import`,
    source: s,
    target: t,
    kind: "import" as const,
    occurrences: [],
    count: 1,
    originalEdgeIds: [],
  });
  // r → a, r → b, a → c  (dependency depth: r=0, a/b=1, c=2)
  const tree: GraphView = { nodes: ["r", "a", "b", "c"].map(mk), edges: [ed("r", "a"), ed("r", "b"), ed("a", "c")] };
  const centerOf = (p: { x: number; y: number }) => ({ x: p.x + 100, y: p.y + 28 });
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const a = centerOf(p);
    const b = centerOf(q);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  test("places dependency depth as concentric rings (root center, leaves outer)", () => {
    const pos = layoutView(tree, { algorithm: "radial" });
    expect(dist(pos.get("a")!, pos.get("r")!)).toBeGreaterThan(50);
    expect(dist(pos.get("c")!, pos.get("r")!)).toBeGreaterThan(dist(pos.get("a")!, pos.get("r")!));
  });

  test("is deterministic regardless of input order", () => {
    const scrambled: GraphView = { nodes: ["c", "b", "a", "r"].map(mk), edges: tree.edges };
    const p1 = layoutView(tree, { algorithm: "radial" });
    const p2 = layoutView(scrambled, { algorithm: "radial" });
    for (const id of ["r", "a", "b", "c"]) expect(p2.get(id)).toEqual(p1.get(id));
  });
});

describe("layered layout uses edge weights", () => {
  // p,q feed x,y. The HEAVY (architectural) edges are p→y and q→x; p→x and q→y
  // are light calls. Weighted crossing reduction should keep the heavy edges from
  // crossing — i.e. p sits on the same side as y, q on the same side as x.
  const g: LayoutInput = {
    nodes: ["p", "q", "x", "y"].map((id) => ({ id, kind: "file" })),
    edges: [
      { source: "p", target: "x", kind: "call", count: 1, weight: edgeWeight("call", 1) },
      { source: "p", target: "y", kind: "extends", count: 1, weight: edgeWeight("extends", 1) },
      { source: "q", target: "x", kind: "extends", count: 1, weight: edgeWeight("extends", 1) },
      { source: "q", target: "y", kind: "call", count: 1, weight: edgeWeight("call", 1) },
    ],
  };

  test("orders ranks to keep the heavier edges from crossing", () => {
    const pos = layoutView(g, { algorithm: "layered", direction: "TB" });
    // Reflection-invariant: (p left of q) iff (y left of x) → heavy edges aligned.
    const side = (pos.get("p")!.x - pos.get("q")!.x) * (pos.get("y")!.x - pos.get("x")!.x);
    expect(side).toBeGreaterThan(0);
  });
});

describe("tree layout is a real tidy tree", () => {
  const mk = (id: string): GraphView["nodes"][number] => ({
    id,
    kind: "file" as const,
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
  });
  const ed = (s: string, t: string) => ({
    id: `${s}->${t}:import`,
    source: s,
    target: t,
    kind: "import" as const,
    occurrences: [],
    count: 1,
    originalEdgeIds: [],
  });
  // r → a, r → b, a → c
  const tree: GraphView = { nodes: ["r", "a", "b", "c"].map(mk), edges: [ed("r", "a"), ed("r", "b"), ed("a", "c")] };

  test("TB places parents above children and spreads siblings horizontally", () => {
    const pos = layoutView(tree, { algorithm: "tree", direction: "TB" });
    expect(pos.get("r")!.y).toBeLessThan(pos.get("a")!.y); // parent above child
    expect(pos.get("a")!.y).toBeLessThan(pos.get("c")!.y); // grandchild lower still
    expect(pos.get("a")!.x).not.toBe(pos.get("b")!.x); // siblings spread out
  });

  test("is deterministic regardless of input order", () => {
    const scrambled: GraphView = { nodes: ["c", "b", "a", "r"].map(mk), edges: tree.edges };
    const p1 = layoutView(tree, { algorithm: "tree", direction: "TB" });
    const p2 = layoutView(scrambled, { algorithm: "tree", direction: "TB" });
    for (const id of ["r", "a", "b", "c"]) expect(p2.get(id)).toEqual(p1.get(id));
  });
});

describe("runLayout: Smart planner + engine distinctness", () => {
  const ed = (s: string, t: string) => ({
    source: s,
    target: t,
    kind: "import" as const,
    count: 1,
    weight: edgeWeight("import", 1),
  });

  test("ungrouped Smart routes a tree-shaped graph to the tree engine", () => {
    const g: LayoutInput = {
      nodes: ["r", "a", "b", "c"].map((id) => ({ id, kind: "file" })),
      edges: [ed("r", "a"), ed("r", "b"), ed("a", "c")],
    };
    const smart = runLayout(g, { algorithm: "smart", groupBy: "none", direction: "TB" });
    const asTree = layoutView(g, { algorithm: "tree", direction: "TB" });
    expect(smart.nodes.get("r")).toEqual(asTree.get("r"));
    expect(smart.nodes.get("c")).toEqual(asTree.get("c"));
  });

  test("classic engines stay distinct when groupBy is set (no homogenization)", () => {
    // Regression: routing grouped classic engines through smart collapsed every one
    // to 'layered' (engineToMode), so switching layouts did nothing. Each engine must
    // produce its own distinct layout regardless of groupBy.
    const g: LayoutInput = {
      nodes: ["wa/a", "wb/b", "wc/c", "wd/d"].map((id) => ({ id, kind: "file" })),
      edges: [ed("wa/a", "wb/b"), ed("wb/b", "wc/c"), ed("wc/c", "wd/d"), ed("wd/d", "wa/a")],
    };
    const circular = runLayout(g, { algorithm: "circular", groupBy: "directory" }).nodes;
    const layered = runLayout(g, { algorithm: "layered", groupBy: "directory" }).nodes;
    const tree = runLayout(g, { algorithm: "tree", groupBy: "directory" }).nodes;
    expect(circular).not.toEqual(layered);
    expect(tree).not.toEqual(layered);
  });
});

describe("backbone layout (core + satellites)", () => {
  const mk = (id: string) => ({ id, kind: "file" as const });
  const ed = (s: string, t: string) => ({
    source: s,
    target: t,
    kind: "import" as const,
    count: 1,
    weight: edgeWeight("import", 1),
  });

  test("hangs a leaf off its core anchor at the satellite radius", () => {
    // Triangle a,b,c (2-core) + leaf d on a.
    const g: LayoutInput = {
      nodes: ["a", "b", "c", "d"].map(mk),
      edges: [ed("a", "b"), ed("b", "c"), ed("c", "a"), ed("a", "d")],
    };
    const pos = layoutView(g, { algorithm: "backbone" });
    const ctr = (id: string) => ({ x: pos.get(id)!.x + 100, y: pos.get(id)!.y + 28 });
    const d = ctr("d");
    const a = ctr("a");
    expect(Math.hypot(d.x - a.x, d.y - a.y)).toBeCloseTo(200, 0);
  });

  test("falls back to a tidy tree when there is no dense core", () => {
    const g: LayoutInput = { nodes: ["r", "x", "y"].map(mk), edges: [ed("r", "x"), ed("r", "y")] };
    const pos = layoutView(g, { algorithm: "backbone" });
    expect(pos.get("r")!.y).toBeLessThan(pos.get("x")!.y);
  });
});

describe("stress layout (cola.js)", () => {
  const mk = (id: string) => ({ id, kind: "file" as const });
  const ed = (s: string, t: string) => ({
    source: s,
    target: t,
    kind: "import" as const,
    count: 1,
    weight: edgeWeight("import", 1),
  });
  const g: LayoutInput = { nodes: ["a", "b", "c"].map(mk), edges: [ed("a", "b"), ed("b", "c")] };
  const ctr = (pos: Map<string, { x: number; y: number }>, id: string) => ({
    x: pos.get(id)!.x + 100,
    y: pos.get(id)!.y + 28,
  });
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y);

  test("places graph-distant nodes farther apart (preserves graph distance)", () => {
    const pos = layoutView(g, { algorithm: "stress" });
    expect(dist(ctr(pos, "a"), ctr(pos, "c"))).toBeGreaterThan(dist(ctr(pos, "a"), ctr(pos, "b")));
  });

  test("is deterministic across runs", () => {
    const p1 = layoutView(g, { algorithm: "stress" });
    const p2 = layoutView(g, { algorithm: "stress" });
    for (const id of ["a", "b", "c"]) expect(p2.get(id)).toEqual(p1.get(id));
  });
});
