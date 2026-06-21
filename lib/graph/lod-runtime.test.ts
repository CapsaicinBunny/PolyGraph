import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy } from "./representation";
import { bootstrapCut, cutFromSelection, cutSignature } from "./lod-cut-solver";
import {
  commitIfMaterial,
  createLodRuntime,
  IntrusiveLru,
  setPending,
} from "./lod-runtime";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

const graph: GraphModel = {
  nodes: ["a/x/f1.c", "a/x/f2.c", "a/y/f3.c", "b/z/f4.c", "b/z/f5.c"].map(file),
  edges: [makeEdge("a/x/f1.c", "b/z/f4.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const h = buildRepresentationHierarchy(snap, nodeIds);

const sigOf = (cut: { selectedRepresentations: Uint32Array }) =>
  cutSignature(cut as never, 0, 0, "filters:v1");

describe("createLodRuntime — initial committed cut", () => {
  test("starts with the bootstrap as both pending and committed at generation 0", () => {
    const boot = bootstrapCut(h);
    const rt = createLodRuntime(boot, sigOf(boot));
    expect(rt.generation).toBe(0);
    expect(rt.committedCut).toBe(boot);
    expect(rt.pendingCut).toBe(boot);
  });
});

describe("commitIfMaterial — ONLY a committed generation triggers a rebuild", () => {
  test("a materially-different pending cut commits and bumps the generation", () => {
    const boot = bootstrapCut(h);
    const rt = createLodRuntime(boot, sigOf(boot));
    const refined = cutFromSelection(h, [...nodeIds.map((_, i) => h.columns.leafRepresentationByNode[i])], 0);
    setPending(rt, refined, sigOf(refined));
    const committed = commitIfMaterial(rt);
    expect(committed).toBe(true);
    expect(rt.generation).toBe(1);
    expect(rt.committedCut).toBe(refined);
  });

  test("an immaterial pending change (same signature) does NOT commit", () => {
    const boot = bootstrapCut(h);
    const rt = createLodRuntime(boot, sigOf(boot));
    // A *different object* with the SAME selected reps (and edge/label stage + filters).
    const sameCut = cutFromSelection(h, [...boot.selectedRepresentations], 99);
    setPending(rt, sameCut, sigOf(sameCut));
    const committed = commitIfMaterial(rt);
    expect(committed).toBe(false);
    expect(rt.generation).toBe(0); // unchanged
    expect(rt.committedCut).toBe(boot); // still the original committed object
  });

  test("pending churn between commits doesn't advance the generation until a commit", () => {
    const boot = bootstrapCut(h);
    const rt = createLodRuntime(boot, sigOf(boot));
    const a = cutFromSelection(h, [...boot.selectedRepresentations], 1);
    const b = cutFromSelection(h, [...boot.selectedRepresentations], 2);
    setPending(rt, a, sigOf(a));
    setPending(rt, b, sigOf(b));
    expect(commitIfMaterial(rt)).toBe(false); // same signature as committed → no commit
    expect(rt.generation).toBe(0);
  });

  test("the generation increases monotonically across successive material commits", () => {
    const boot = bootstrapCut(h);
    const rt = createLodRuntime(boot, sigOf(boot));
    const c1 = cutFromSelection(h, [h.repOfGroup[0]], 0); // some other antichain-ish set
    const sig1 = cutSignature(c1 as never, 1, 0, "filters:v1"); // different edge stage
    setPending(rt, c1, sig1);
    expect(commitIfMaterial(rt)).toBe(true);
    expect(rt.generation).toBe(1);
    const sig2 = cutSignature(c1 as never, 2, 0, "filters:v1"); // different again
    setPending(rt, c1, sig2);
    expect(commitIfMaterial(rt)).toBe(true);
    expect(rt.generation).toBe(2);
  });
});

describe("IntrusiveLru — bounded offscreen eviction, no array shift / churning Sets", () => {
  test("touch inserts; oldest is evicted first (FIFO of least-recently-touched)", () => {
    const lru = new IntrusiveLru(8); // capacity = #reps it can track
    lru.touch(2);
    lru.touch(5);
    lru.touch(7);
    // 2 is the least-recently-touched → evicted first.
    expect(lru.evictOldest()).toBe(2);
    expect(lru.evictOldest()).toBe(5);
    expect(lru.size).toBe(1);
  });

  test("re-touching a key moves it to most-recently-used (won't be evicted next)", () => {
    const lru = new IntrusiveLru(8);
    lru.touch(2);
    lru.touch(5);
    lru.touch(2); // 2 is now MRU
    expect(lru.evictOldest()).toBe(5); // 5 is now the oldest
    expect(lru.evictOldest()).toBe(2);
  });

  test("eviction is bounded: tracking many keys past capacity stays within capacity", () => {
    const cap = 4;
    const lru = new IntrusiveLru(16, cap);
    const evicted: number[] = [];
    for (let r = 0; r < 12; r++) {
      const auto = lru.touch(r); // touch returns any auto-evicted key when over capacity
      if (auto !== -1) evicted.push(auto);
    }
    expect(lru.size).toBeLessThanOrEqual(cap); // never exceeds the cap
    // The earliest-touched keys were the ones auto-evicted.
    expect(evicted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The survivors are the last `cap` touched.
    const survivors: number[] = [];
    let e = lru.evictOldest();
    while (e !== -1) {
      survivors.push(e);
      e = lru.evictOldest();
    }
    expect(survivors).toEqual([8, 9, 10, 11]);
  });

  test("has() / remove() keep membership consistent", () => {
    const lru = new IntrusiveLru(8);
    lru.touch(3);
    expect(lru.has(3)).toBe(true);
    lru.remove(3);
    expect(lru.has(3)).toBe(false);
    expect(lru.size).toBe(0);
    expect(lru.evictOldest()).toBe(-1); // empty
  });

  test("evicting from empty returns -1 (no underflow)", () => {
    const lru = new IntrusiveLru(8);
    expect(lru.evictOldest()).toBe(-1);
  });
});
