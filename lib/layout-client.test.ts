import { describe, expect, test } from "bun:test";
import { layoutInWorker } from "./layout-client";

// In bun (no DOM Worker) layoutInWorker runs the synchronous fallback.
const view = { nodes: [{ id: "pkg/a.ts", kind: "file" }], edges: [] };

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
