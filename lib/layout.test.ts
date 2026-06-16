import { describe, expect, test } from "bun:test";
import type { GraphView } from "./aggregate";
import { type LayoutAlgorithm, layoutView } from "./layout";

// A → B, so the layout should place B "after" A along the flow axis.
const view: GraphView = {
  nodes: [
    { id: "a", kind: "file", label: "a", filePath: "a", line: 0, parentFile: "a" },
    { id: "b", kind: "file", label: "b", filePath: "b", line: 0, parentFile: "b" },
  ],
  edges: [{ id: "a->b:import", source: "a", target: "b", kind: "import" }],
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
      { id: "a->b:import", source: "a", target: "b", kind: "import" },
      { id: "a->c:import", source: "a", target: "c", kind: "import" },
      { id: "b->d:import", source: "b", target: "d", kind: "import" },
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
