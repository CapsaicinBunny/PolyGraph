import { describe, expect, test } from "bun:test";
import type { LayoutInput } from "./layout";
import { guardOptions, layoutInWorker } from "./layout-client";

// In bun (no DOM Worker) layoutInWorker runs the synchronous fallback.
const view = { nodes: [{ id: "pkg/a.ts", kind: "file" }], edges: [] };

describe("guardOptions", () => {
  test("leaves small inputs on the requested algorithm", () => {
    expect(guardOptions(view, { algorithm: "smart", direction: "LR" }).algorithm).toBe("smart");
  });

  test("forces grid for inputs above the heavy-layout threshold", () => {
    const big: LayoutInput = {
      nodes: Array.from({ length: 6001 }, (_, i) => ({ id: `n${i}`, kind: "file" })),
      edges: [],
    };
    const guarded = guardOptions(big, {
      algorithm: "smart",
      direction: "LR",
      groupBy: "directory",
    });
    expect(guarded.algorithm).toBe("grid");
    expect(guarded.groupBy).toBe("none");
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
