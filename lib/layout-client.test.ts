import { describe, expect, test } from "bun:test";
import type { LayoutInput } from "./layout";
import { guardOptions, layoutInWorker } from "./layout-client";

// In bun (no DOM Worker) layoutInWorker runs the synchronous fallback.
const view = { nodes: [{ id: "pkg/a.ts", kind: "file" }], edges: [] };

describe("guardOptions (per-algorithm)", () => {
  const big = (n: number): LayoutInput => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: "file" })),
    edges: [],
  });

  test("leaves small inputs on the requested algorithm", () => {
    expect(guardOptions(view, { algorithm: "smart", direction: "LR" }).algorithm).toBe("smart");
  });

  test("Smart + grouping scales: passes through far above the heavy cap", () => {
    // Must NOT be gridded — grid emits no cluster boxes, which would disable the LOD cut.
    expect(guardOptions(big(6001), { algorithm: "smart", groupBy: "directory" }).algorithm).toBe(
      "smart",
    );
  });

  test("Smart + grouping is still capped at the scalable ceiling", () => {
    expect(guardOptions(big(60001), { algorithm: "smart", groupBy: "directory" }).algorithm).toBe(
      "grid",
    );
  });

  test("a non-smart engine is capped at the heavy threshold", () => {
    expect(guardOptions(big(6001), { algorithm: "layered" }).algorithm).toBe("grid");
  });

  test("Smart + None is capped (no grouping → no cluster scaling)", () => {
    expect(guardOptions(big(6001), { algorithm: "smart", groupBy: "none" }).algorithm).toBe("grid");
  });
});

describe("layoutInWorker fallback", () => {
  test("smart returns positions and cluster boxes", async () => {
    const { positions, clusters } = await layoutInWorker(view, {
      algorithm: "smart",
      direction: "LR",
    });
    expect(positions.get("pkg/a.ts")).toBeTruthy();
    expect(clusters.map((c) => c.id)).toContain("pkg");
  });

  test("non-smart returns no clusters", async () => {
    const { clusters } = await layoutInWorker(view, { algorithm: "layered", direction: "LR" });
    expect(clusters).toEqual([]);
  });
});
