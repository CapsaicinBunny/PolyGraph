import { describe, expect, test } from "bun:test";
import type { GraphView } from "./aggregate";
import { layoutView } from "./layout";

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
