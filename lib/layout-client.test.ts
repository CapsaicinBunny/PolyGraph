import { describe, expect, test } from "bun:test";
import type { LayoutInput } from "./layout";
import { guardOptions, layoutInWorker } from "./layout-client";

// In bun (no DOM Worker) layoutInWorker runs the synchronous fallback.
const view = { nodes: [{ id: "pkg/a.ts", kind: "file" }], edges: [] };

const nodes = (n: number): LayoutInput => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: "file" })),
  edges: [],
});

describe("guardOptions", () => {
  test("leaves small inputs on the requested algorithm", () => {
    expect(guardOptions(view, { algorithm: "smart", direction: "LR" }).algorithm).toBe("smart");
  });

  test("keeps smart for big-but-tractable inputs (it scales and keeps clusters)", () => {
    // Smart is cluster-based and lays out tens of thousands of nodes quickly; forcing
    // it to grid would strip the directory clusters the adaptive LOD cut depends on.
    expect(
      guardOptions(nodes(6001), { algorithm: "smart", direction: "LR", groupBy: "directory" })
        .algorithm,
    ).toBe("smart");
  });

  test("forces grid for smart only past its much higher threshold", () => {
    const guarded = guardOptions(nodes(60_001), {
      algorithm: "smart",
      direction: "LR",
      groupBy: "directory",
    });
    expect(guarded.algorithm).toBe("grid");
    expect(guarded.groupBy).toBe("none");
  });

  test("forces grid for non-smart algorithms at the lower threshold", () => {
    // Monolithic dagre (layered/tree) and force don't scale, so they cap low.
    expect(guardOptions(nodes(6001), { algorithm: "layered", direction: "LR" }).algorithm).toBe(
      "grid",
    );
  });

  test("caps smart at the low threshold when grouping is off (it degenerates to one dagre)", () => {
    // groupBy:"none" puts every node in the root cluster → one monolithic dagre, no
    // cluster boxes, so smart loses its scaling and gets the low cap like the rest.
    expect(
      guardOptions(nodes(6001), { algorithm: "smart", direction: "LR", groupBy: "none" }).algorithm,
    ).toBe("grid");
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
