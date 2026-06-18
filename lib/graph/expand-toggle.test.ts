import { describe, expect, test } from "bun:test";
import { nextExpandAll } from "./expand-toggle";

describe("nextExpandAll", () => {
  const fileIds = ["a.ts", "b.ts", "c.ts"];
  const seed = new Set(["dir/x"]);

  test("expanding opens every file and turns Adaptive LOD off", () => {
    const next = nextExpandAll(false, fileIds, seed);
    expect([...next.expanded].sort()).toEqual([...fileIds].sort());
    // Adaptive LOD must be off, or a zoom-out re-collapses the expansion.
    expect(next.adaptiveLod).toBe(false);
    // The bounded seed is kept so a huge repo isn't drawn whole.
    expect(next.collapsedClusters).toBe(seed);
  });

  test("collapsing clears expansion, reseeds the cut, and turns Adaptive LOD back on", () => {
    const next = nextExpandAll(true, fileIds, seed);
    expect(next.expanded.size).toBe(0);
    // Back to the bounded overview default — never stranded with LOD off.
    expect(next.adaptiveLod).toBe(true);
    // Reseeding (not leaving a stale cut) is what keeps nodes from vanishing
    // until a rescan after collapse.
    expect(next.collapsedClusters).toBe(seed);
  });

  test("with no auto-collapse (small repo) expanding opens everything uncollapsed", () => {
    const next = nextExpandAll(false, fileIds, new Set());
    expect(next.collapsedClusters.size).toBe(0);
    expect(next.expanded.size).toBe(fileIds.length);
  });
});
