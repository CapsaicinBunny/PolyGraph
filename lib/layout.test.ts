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
      return {
        id: `${s}->${t}:import`,
        source: s,
        target: t,
        kind: "import" as const,
        occurrences: [],
        count: 1,
        originalEdgeIds: [],
      };
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

  test("keeps communities contiguous on the ring", () => {
    const mkn = (id: string): GraphView["nodes"][number] => ({
      id,
      kind: "file",
      label: id,
      filePath: id,
      line: 0,
      parentFile: id,
    });
    const e = (s: string, t: string) => ({
      id: `${s}->${t}`,
      source: s,
      target: t,
      kind: "import" as const,
      occurrences: [],
      count: 1,
      originalEdgeIds: [],
    });
    // Two triangles {a,b,c} and {d,e,f} joined by a single bridge c–d → two communities.
    const g: GraphView = {
      nodes: ["a", "b", "c", "d", "e", "f"].map(mkn),
      edges: [
        e("a", "b"),
        e("b", "c"),
        e("c", "a"),
        e("d", "e"),
        e("e", "f"),
        e("f", "d"),
        e("c", "d"),
      ],
    };
    const pos = layoutView(g, { algorithm: "circular" });
    const all = ["a", "b", "c", "d", "e", "f"];
    // The ring is offset by component packing, so measure angles from its centroid.
    const cx = all.reduce((s, id) => s + pos.get(id)!.x + 100, 0) / all.length;
    const cy = all.reduce((s, id) => s + pos.get(id)!.y + 28, 0) / all.length;
    const order = all
      .map((id) => {
        const p = pos.get(id)!;
        return { id, ang: Math.atan2(p.y + 28 - cy, p.x + 100 - cx) };
      })
      .sort((u, v) => u.ang - v.ang)
      .map((u) => u.id);
    // The three {a,b,c} nodes must form exactly one contiguous arc (one cyclic run).
    const A = new Set(["a", "b", "c"]);
    let runStarts = 0;
    for (let i = 0; i < 6; i++) if (A.has(order[i]) && !A.has(order[(i + 5) % 6])) runStarts++;
    expect(runStarts).toBe(1);
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

  test("graph-locality mode keeps connected nodes in adjacent cells (RCM + serpentine)", () => {
    // A path a–b–c–d: RCM keeps it in sequence, serpentine fill keeps each consecutive
    // pair in a grid-adjacent cell (incl. across the row wrap), not diagonally apart.
    const g: LayoutInput = {
      nodes: ["a", "b", "c", "d"].map((id) => ({ id, kind: "file" })),
      edges: [
        { source: "a", target: "b", kind: "import", count: 1, weight: edgeWeight("import", 1) },
        { source: "b", target: "c", kind: "import", count: 1, weight: edgeWeight("import", 1) },
        { source: "c", target: "d", kind: "import", count: 1, weight: edgeWeight("import", 1) },
      ],
    };
    const pos = layoutView(g, { algorithm: "grid" });
    const cell = (id: string) => ({
      c: Math.round(pos.get(id)!.x / 250),
      r: Math.round(pos.get(id)!.y / 110),
    });
    for (const [s, t] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]) {
      const A = cell(s);
      const B = cell(t);
      expect(Math.abs(A.c - B.c) + Math.abs(A.r - B.r)).toBe(1); // grid-adjacent
    }
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
  const tree: GraphView = {
    nodes: ["r", "a", "b", "c"].map(mk),
    edges: [ed("r", "a"), ed("r", "b"), ed("a", "c")],
  };
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

  test("circular-mean barycenter places a node near its parent, not the opposite side", () => {
    // R→a, R→b put a/b on opposite sides of ring 1; c hangs off a, d off b. The angular
    // barycenter must pull c next to a and d next to b (a linear-index average wraps and
    // could place them mid-ring).
    const g: GraphView = {
      nodes: ["R", "a", "b", "c", "d"].map(mk),
      edges: [ed("R", "a"), ed("R", "b"), ed("a", "c"), ed("b", "d")],
    };
    const pos = layoutView(g, { algorithm: "radial" });
    const o = centerOf(pos.get("R")!); // R is the ring center (depth 0)
    const ang = (id: string) => {
      const c = centerOf(pos.get(id)!);
      return Math.atan2(c.y - o.y, c.x - o.x);
    };
    const adist = (p: string, q: string) => {
      const d = Math.abs(ang(p) - ang(q));
      return Math.min(d, 2 * Math.PI - d);
    };
    expect(adist("c", "a")).toBeLessThan(adist("c", "b"));
    expect(adist("d", "b")).toBeLessThan(adist("d", "a"));
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
  const tree: GraphView = {
    nodes: ["r", "a", "b", "c"].map(mk),
    edges: [ed("r", "a"), ed("r", "b"), ed("a", "c")],
  };

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

  test("hangs a leaf off its core anchor (fanned, not on the core)", () => {
    // Triangle a,b,c (2-core) + leaf d on a. The leaf is placed off its anchor at the
    // phyllotaxis radius — close enough to read as attached, far enough not to overlap.
    const g: LayoutInput = {
      nodes: ["a", "b", "c", "d"].map(mk),
      edges: [ed("a", "b"), ed("b", "c"), ed("c", "a"), ed("a", "d")],
    };
    const pos = layoutView(g, { algorithm: "backbone" });
    const ctr = (id: string) => ({ x: pos.get(id)!.x + 100, y: pos.get(id)!.y + 28 });
    const d = ctr("d");
    const a = ctr("a");
    const dist = Math.hypot(d.x - a.x, d.y - a.y);
    expect(dist).toBeGreaterThan(80);
    expect(dist).toBeLessThan(400);
  });

  test("falls back to a tidy tree when there is no dense core", () => {
    const g: LayoutInput = { nodes: ["r", "x", "y"].map(mk), edges: [ed("r", "x"), ed("r", "y")] };
    const pos = layoutView(g, { algorithm: "backbone" });
    expect(pos.get("r")!.y).toBeLessThan(pos.get("x")!.y);
  });

  test("is deterministic (adaptive core + weighted anchor + overlap relax)", () => {
    // Triangle core a,b,c + leaves on each — exercises the full path incl. relaxOverlaps.
    const g: LayoutInput = {
      nodes: ["a", "b", "c", "d", "e", "f", "g"].map(mk),
      edges: [
        ed("a", "b"),
        ed("b", "c"),
        ed("c", "a"),
        ed("a", "d"),
        ed("a", "e"),
        ed("b", "f"),
        ed("c", "g"),
      ],
    };
    const p1 = layoutView(g, { algorithm: "backbone" });
    const p2 = layoutView(g, { algorithm: "backbone" });
    expect([...p1.entries()]).toEqual([...p2.entries()]);
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

describe("radial ring sizing (no overlap on crowded rings)", () => {
  test("expands a ring's radius to fit its node count", () => {
    // 1 root with 24 children all at depth 1: the ring must be large enough that
    // adjacent children don't overlap (old fixed radius=260 crammed them together).
    const n = 24;
    const nodes: LayoutInput["nodes"] = [
      { id: "root", kind: "file" },
      ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: "file" as const })),
    ];
    const edges: LayoutInput["edges"] = Array.from({ length: n }, (_, i) => ({
      source: "root",
      target: `c${i}`,
      kind: "import" as const,
      count: 1,
      weight: edgeWeight("import", 1),
    }));
    const pos = layoutView({ nodes, edges }, { algorithm: "radial" });
    const centers = Array.from({ length: n }, (_, i) => {
      const p = pos.get(`c${i}`)!;
      return { x: p.x + 100, y: p.y + 28 };
    });
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        minDist = Math.min(
          minDist,
          Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y),
        );
    expect(minDist).toBeGreaterThan(140); // ~no overlap (cards are ~200 wide)
  });
});

describe("heavy-engine safety caps (no engine pins a core)", () => {
  // Grid fallback packs nodes into ~sqrt(n) columns, so a small distinct-x count proves
  // the heavy engine was bypassed (real stress/force give ~n continuous x positions).
  const distinctColumns = (pos: Map<string, { x: number; y: number }>) =>
    new Set([...pos.values()].map((p) => Math.round(p.x))).size;

  const chain = (n: number): LayoutInput => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: "file" as const })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({
      source: `s${i}`,
      target: `s${i + 1}`,
      kind: "import" as const,
      count: 1,
      weight: edgeWeight("import", 1),
    })),
  });

  test("stress scales to large components via PivotMDS (no longer grids at ~1000)", () => {
    // 1500 nodes used to grid (old ~O(n²) cap); PivotMDS lays them out for real now.
    const pos = layoutView(chain(1500), { algorithm: "stress" });
    expect(pos.size).toBe(1500);
    expect(distinctColumns(pos)).toBeGreaterThan(200); // continuous positions → it ran
  });

  test("stress still grids a component past the (much higher) cap", () => {
    const pos = layoutView(chain(6001), { algorithm: "stress" }); // > HEAVY_COMPONENT_CAP.stress
    expect(pos.size).toBe(6001);
    expect(distinctColumns(pos)).toBeLessThan(150); // gridded past the cap
  });

  test("force falls back to grid for an oversized view", () => {
    const n = 2100; // > the force whole-view cap (2000)
    const nodes: LayoutInput["nodes"] = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      kind: "file" as const,
    }));
    const pos = layoutView({ nodes, edges: [] }, { algorithm: "force" });
    expect(pos.size).toBe(n);
    expect(distinctColumns(pos)).toBeLessThan(120);
  });
});

describe("heavy engines keep cards from overlapping", () => {
  const W = 200;
  const H = 56; // file card size
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x < b.x + W && b.x < a.x + W && a.y < b.y + H && b.y < a.y + H;
  const anyOverlap = (pos: Map<string, { x: number; y: number }>, ids: string[]) => {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]);
        const b = pos.get(ids[j]);
        if (a && b && overlaps(a, b)) return true;
      }
    return false;
  };
  const ed = (s: string, t: string) => ({
    source: s,
    target: t,
    kind: "import" as const,
    count: 1,
    weight: edgeWeight("import", 1),
  });

  test("stress: avoidOverlaps keeps cards apart", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const nodes: LayoutInput["nodes"] = ids.map((id) => ({ id, kind: "file" }));
    const edges: LayoutInput["edges"] = ids.map((_, i) => ed(`s${i}`, `s${(i + 1) % 12}`));
    const pos = layoutView({ nodes, edges }, { algorithm: "stress" });
    expect(anyOverlap(pos, ids)).toBe(false);
  });

  test("backbone: a hub's many leaves fan out without overlap", () => {
    const leaves = Array.from({ length: 20 }, (_, i) => `L${i}`);
    const nodes: LayoutInput["nodes"] = ["a", "b", "c", ...leaves].map((id) => ({
      id,
      kind: "file",
    }));
    const edges: LayoutInput["edges"] = [
      ed("a", "b"),
      ed("b", "c"),
      ed("c", "a"),
      ...leaves.map((l) => ed("a", l)),
    ];
    const pos = layoutView({ nodes, edges }, { algorithm: "backbone" });
    expect(anyOverlap(pos, leaves)).toBe(false);
  });
});

describe("tree sibling ordering (subtree size + weight)", () => {
  const W = (s: string, t: string) => ({
    source: s,
    target: t,
    kind: "import" as const,
    count: 1,
    weight: edgeWeight("import", 1),
  });

  test("orders a bigger subtree before a leaf sibling", () => {
    // Under r: a carries a subtree of 3 (a,c,d), b is a leaf. Bigger subtree → ordered
    // first → a's cross-axis (x in TB) sits left of the leaf b's.
    const g: LayoutInput = {
      nodes: ["r", "a", "b", "c", "d"].map((id) => ({ id, kind: "file" })),
      edges: [W("r", "a"), W("r", "b"), W("a", "c"), W("a", "d")],
    };
    const pos = layoutView(g, { algorithm: "tree", direction: "TB" });
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  });

  test("is deterministic", () => {
    const g: LayoutInput = {
      nodes: ["r", "a", "b", "c"].map((id) => ({ id, kind: "file" })),
      edges: [W("r", "a"), W("r", "b"), W("b", "c")],
    };
    const a = layoutView(g, { algorithm: "tree", direction: "TB" });
    const b = layoutView(g, { algorithm: "tree", direction: "TB" });
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
