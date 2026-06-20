import { describe, expect, test } from "bun:test";
import { candidateEngines, chooseEngine } from "./planner";
import { graphShape } from "./shape";

const E = (source: string, target: string) => ({ source, target });

describe("chooseEngine (Smart planner)", () => {
  test("picks tree for a rooted tree", () => {
    const shape = graphShape(["r", "a", "b", "c"], [E("r", "a"), E("r", "b"), E("a", "c")]);
    expect(chooseEngine(shape)).toBe("tree");
  });

  test("picks layered for an acyclic merge (DAG, not a tree)", () => {
    const shape = graphShape(
      ["a", "b", "c", "d"],
      [E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d")],
    );
    expect(chooseEngine(shape)).toBe("layered");
  });

  test("picks circular for a small cyclic component", () => {
    const shape = graphShape(["a", "b", "c"], [E("a", "b"), E("b", "c"), E("c", "a")]);
    expect(chooseEngine(shape)).toBe("circular");
  });

  test("picks grid for a set of isolates", () => {
    const shape = graphShape(["a", "b", "c"], []);
    expect(chooseEngine(shape)).toBe("grid");
  });

  test("picks backbone for a dense core with many leaves", () => {
    const edges = [E("a", "b"), E("b", "c"), E("c", "a")]; // triangle core
    for (const leaf of ["d", "e", "f", "g", "h"]) edges.push(E("a", leaf)); // five leaves on a
    const shape = graphShape(["a", "b", "c", "d", "e", "f", "g", "h"], edges);
    expect(chooseEngine(shape)).toBe("backbone");
  });

  test("picks stress for a large cyclic component (too big for a single ring)", () => {
    // A 70-node directed cycle: one SCC, but past CIRCULAR_MAX, so circular is out and
    // stress (which untangles cycles well) should win while it's still under the cap.
    const ids = Array.from({ length: 70 }, (_, i) => `n${i}`);
    const edges = ids.map((id, i) => E(id, ids[(i + 1) % ids.length]));
    expect(chooseEngine(graphShape(ids, edges))).toBe("stress");
  });

  test("never returns 'smart' (no infinite recursion)", () => {
    const shape = graphShape(["a", "b"], [E("a", "b")]);
    expect(chooseEngine(shape)).not.toBe("smart");
  });
});

describe("candidateEngines", () => {
  test("returns just the primary for clear-cut shapes (grid)", () => {
    expect(candidateEngines(graphShape(["a", "b", "c"], []))).toEqual(["grid"]);
  });

  test("returns the primary plus alternates for an ambiguous shape", () => {
    const ids = Array.from({ length: 70 }, (_, i) => `n${i}`);
    const cands = candidateEngines(
      graphShape(
        ids,
        ids.map((id, i) => E(id, ids[(i + 1) % ids.length])),
      ),
    );
    expect(cands[0]).toBe("stress"); // primary first
    expect(cands.length).toBeGreaterThan(1);
    expect(new Set(cands).size).toBe(cands.length); // deduped
  });
});
