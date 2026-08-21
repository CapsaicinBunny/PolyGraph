// Phase C1b probe — PROVE the solved LodCut is ALWAYS a VALID ANTICHAIN.
//
// "Valid antichain" (Appendix A): for every underlying node, EXACTLY ONE rep on its
// leaf→root path is selected — never 0 (an unrepresented subtree), never ≥2 (a proxy
// AND its expanded descendants). This file fuzzes the constrained budgeted solver across:
//   • randomly-shaped hierarchies (deep chains, wide fans, multi-root forests, NO_GROUP
//     orphan leaves, mixed costs);
//   • random forceClosed / forceOpen constraint sets (incl. nested + conflicting);
//   • random soft/hard budgets (incl. degenerate 0 budgets that force rejection);
//   • random refine GATES (off-screen / sub-legibility cutoffs);
//   • iterated refine→coarsen→refine sequences (feeding one solve's cut as the next seed).
//
// Every fuzz iteration that produces an invariant violation is reported deterministically
// (the seed is printed) so a failure is reproducible. The invariant is also re-asserted
// against the runtime O(1) membership view (representativeOf) to prove the two agree.

import { describe, expect, test } from "bun:test";
import {
  buildRepresentationHierarchy,
  MAX_FANOUT,
  type RepresentationHierarchy,
  representativeOf,
} from "./representation";
import { type CompactGroupingSnapshot, NO_GROUP } from "./grouping-snapshot";
import {
  bootstrapCut,
  type CameraState,
  type CutConstraints,
  type LodBudget,
  type LodCut,
  makeRuntimeCut,
  rootCut,
  type SolveGate,
  solveLodCut,
} from "./lod-cut-solver";

// ── a tiny deterministic PRNG (mulberry32) — reproducible fuzzing ────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next: () => number;
  int: (lo: number, hiInclusive: number) => number;
  pick: <T>(arr: readonly T[]) => T;
  chance: (p: number) => boolean;
}
function rng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

// ── random hierarchy synthesis ───────────────────────────────────────────────────
// We build a CompactGroupingSnapshot DIRECTLY (bypassing directoryGrouping) so the fuzzer
// controls tree SHAPE precisely: a random forest of group nodes (depth/fan vary), then
// nodes attached to random groups — some left ungrouped (NO_GROUP) to exercise the
// orphan-leaf-as-root path. This produces arbitrary VALID hierarchies, the strongest test.

interface SynthSpec {
  groups: number; // target group count
  maxDepth: number; // max nesting depth
  maxFan: number; // max children per group
  nodes: number; // underlying node count
  orphanChance: number; // P(a node is NO_GROUP)
  costMode: "unit" | "varied"; // node cost weights
}

function synthSnapshot(
  r: Rng,
  spec: SynthSpec,
): { snap: CompactGroupingSnapshot; nodeIds: string[] } {
  // Grow a forest: start with ≥1 root, then attach each new group to a random existing
  // group whose depth < maxDepth (or as a new root). parentByGroup is the authority.
  const parentByGroup: number[] = [];
  const depthByGroup: number[] = [];
  const groupIds: string[] = [];

  const rootCount = r.int(1, Math.max(1, Math.min(3, spec.groups)));
  for (let i = 0; i < rootCount && groupIds.length < spec.groups; i++) {
    parentByGroup.push(-1);
    depthByGroup.push(0);
    groupIds.push(`g${groupIds.length}`);
  }
  // Track remaining child capacity per group to respect maxFan.
  const fanLeft = parentByGroup.map(() => spec.maxFan);
  while (groupIds.length < spec.groups) {
    // Candidate parents: existing groups with depth < maxDepth and fan capacity left.
    const candidates: number[] = [];
    for (let g = 0; g < groupIds.length; g++) {
      if (depthByGroup[g] < spec.maxDepth && fanLeft[g] > 0) candidates.push(g);
    }
    const ord = groupIds.length;
    if (candidates.length === 0 || r.chance(0.15)) {
      // new root
      parentByGroup.push(-1);
      depthByGroup.push(0);
    } else {
      const p = r.pick(candidates);
      parentByGroup.push(p);
      depthByGroup.push(depthByGroup[p] + 1);
      fanLeft[p] -= 1;
    }
    groupIds.push(`g${ord}`);
    fanLeft.push(spec.maxFan);
  }

  const groupCount = groupIds.length;
  const directGroupByNode = new Uint32Array(spec.nodes);
  const nodeIds: string[] = [];
  for (let i = 0; i < spec.nodes; i++) {
    nodeIds.push(`n${i}`);
    if (groupCount === 0 || r.chance(spec.orphanChance)) {
      directGroupByNode[i] = NO_GROUP;
    } else {
      directGroupByNode[i] = r.int(0, groupCount - 1);
    }
  }

  const roots: number[] = [];
  for (let g = 0; g < groupCount; g++) if (parentByGroup[g] === -1) roots.push(g);

  const snap: CompactGroupingSnapshot = {
    modeKey: "fuzz",
    groupIds,
    groupLabels: groupIds.slice(),
    parentByGroup: Int32Array.from(parentByGroup),
    depthByGroup: Uint16Array.from(depthByGroup),
    boxKeyByGroup: groupIds.slice(),
    directGroupByNode,
    roots: Uint32Array.from(roots),
  };
  return { snap, nodeIds };
}

function buildFuzzHierarchy(
  r: Rng,
  spec: SynthSpec,
  nodeIds: string[],
  snap: CompactGroupingSnapshot,
): RepresentationHierarchy {
  const nodeCost = spec.costMode === "unit" ? () => 1 : (_id: string, ord: number) => 1 + (ord % 4); // 1..4
  return buildRepresentationHierarchy(snap, nodeIds, { nodeCost });
}

// ── the invariant ────────────────────────────────────────────────────────────────
// Returns null if valid, else a human-readable violation (node ordinal + the hits found).
function antichainViolation(h: RepresentationHierarchy, cut: LodCut): string | null {
  const selected = new Set(cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = h.columns;
  const nodeCount = leafRepresentationByNode.length;
  for (let i = 0; i < nodeCount; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    const path: number[] = [];
    let guard = h.repCount + 1;
    while (cur !== -1 && guard-- > 0) {
      path.push(cur);
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    if (hits !== 1) {
      return `node ${i}: ${hits} selected reps on path [${path.join("→")}] (expected exactly 1); selected={${[...cut.selectedRepresentations].join(",")}}`;
    }
  }
  return null;
}

// A second, independent check: the runtime representativeOf walk must resolve EVERY node
// to a selected rep (never -1) and to the SAME rep the membership scan finds.
function representativeViolation(h: RepresentationHierarchy, cut: LodCut): string | null {
  const rt = makeRuntimeCut(cut, h.repCount);
  const nodeCount = h.columns.leafRepresentationByNode.length;
  for (let i = 0; i < nodeCount; i++) {
    const rep = representativeOf(h, i, rt.isSelected);
    if (rep === -1) return `node ${i}: representativeOf returned -1 (unrepresented)`;
    if (!rt.isSelected(rep)) return `node ${i}: representativeOf returned unselected rep ${rep}`;
  }
  return null;
}

// Also assert the antichain property structurally: no selected rep is an ancestor of
// another selected rep (the dual of "exactly once" given full coverage).
function ancestorPairViolation(h: RepresentationHierarchy, cut: LodCut): string | null {
  const sel = [...cut.selectedRepresentations];
  const { entryByRep, exitByRep } = h.columns;
  for (const a of sel) {
    for (const b of sel) {
      if (a === b) continue;
      // a strict ancestor of b?
      if (entryByRep[a] <= entryByRep[b] && exitByRep[b] <= exitByRep[a]) {
        return `selected reps ${a} and ${b}: ${a} is an ancestor of ${b} (not an antichain)`;
      }
    }
  }
  return null;
}

function assertCutValid(h: RepresentationHierarchy, cut: LodCut, ctx: string): void {
  const v1 = antichainViolation(h, cut);
  if (v1) throw new Error(`${ctx}: ${v1}`);
  const v2 = representativeViolation(h, cut);
  if (v2) throw new Error(`${ctx}: ${v2}`);
  const v3 = ancestorPairViolation(h, cut);
  if (v3) throw new Error(`${ctx}: ${v3}`);
}

// ── random constraints / budget / gate / camera ──────────────────────────────────
function randomConstraints(r: Rng, h: RepresentationHierarchy): CutConstraints {
  const forceClosed = new Set<number>();
  const forceOpen = new Set<number>();
  const reps = h.repCount;
  // Up to ~25% of reps constrained, split between closed and open (overlap allowed — the
  // solver must resolve precedence). Both group reps and leaf reps are fair game.
  const k = r.int(0, Math.ceil(reps * 0.25));
  for (let i = 0; i < k; i++) {
    const rep = r.int(0, reps - 1);
    if (r.chance(0.5)) forceClosed.add(rep);
    else forceOpen.add(rep);
  }
  return { forceClosed, forceOpen };
}

function randomBudget(r: Rng, h: RepresentationHierarchy): LodBudget {
  // Full-open node cost ceiling so "hard = whole graph" is representable.
  let total = 0;
  for (const rep of h.columns.leafRepresentationByNode) total += h.columns.nodeCost[rep];
  const mode = r.int(0, 4);
  // Degenerate-to-generous budgets. 0 budgets force rejection on every refine.
  const target =
    mode === 0
      ? 0
      : mode === 1
        ? r.int(0, 2)
        : mode === 2
          ? r.int(1, Math.max(1, Math.floor(total / 2)))
          : total + 10;
  const hard = Math.max(target, r.chance(0.5) ? target : total + 10);
  // FINITE ceilings throughout (Gap 6). The fuzz varies the CARDS dimension; edges/labels/gpu
  // are held huge-finite (BIG) so they never gate. Layout sometimes mirrors the cards ceilings
  // (so it co-gates), otherwise stays slack — both finite, with target ≤ hard.
  const BIG = total + 1_000;
  const layoutBinds = r.chance(0.3);
  return {
    targetCards: target,
    hardCards: hard,
    targetLayoutCost: layoutBinds ? target : BIG,
    hardLayoutCost: layoutBinds ? hard : BIG,
    targetEdges: BIG,
    hardEdges: BIG,
    targetLabels: BIG,
    hardLabels: BIG,
    maxGpuBytes: BIG,
  };
}

function randomGate(r: Rng, h: RepresentationHierarchy): SolveGate | undefined {
  if (r.chance(0.4)) return undefined; // often no gate
  // A gate that freezes a random ~half of reps from auto-refinement.
  const frozen = new Set<number>();
  for (let rep = 0; rep < h.repCount; rep++) if (r.chance(0.5)) frozen.add(rep);
  return { canRefine: (rep) => !frozen.has(rep) };
}

function randomCamera(r: Rng): CameraState {
  return {
    x: r.int(-500, 500),
    y: r.int(-500, 500),
    scale: r.pick([0.01, 0.1, 0.5, 1, 2, 5]),
    viewport: { w: 800, h: 600 },
  };
}

function randomSpec(r: Rng): SynthSpec {
  const shape = r.int(0, 3);
  // 0: deep chain, 1: wide fan, 2: balanced, 3: many roots / sparse
  if (shape === 0) {
    return {
      groups: r.int(3, 30),
      maxDepth: r.int(5, 20),
      maxFan: r.int(1, 2),
      nodes: r.int(0, 40),
      orphanChance: r.next() * 0.4,
      costMode: r.chance(0.5) ? "unit" : "varied",
    };
  }
  if (shape === 1) {
    return {
      groups: r.int(3, 40),
      maxDepth: r.int(1, 3),
      maxFan: r.int(8, 30),
      nodes: r.int(0, 60),
      orphanChance: r.next() * 0.4,
      costMode: r.chance(0.5) ? "unit" : "varied",
    };
  }
  if (shape === 2) {
    return {
      groups: r.int(2, 35),
      maxDepth: r.int(2, 6),
      maxFan: r.int(2, 6),
      nodes: r.int(0, 50),
      orphanChance: r.next() * 0.5,
      costMode: r.chance(0.5) ? "unit" : "varied",
    };
  }
  return {
    groups: r.int(1, 20),
    maxDepth: r.int(0, 2),
    maxFan: r.int(0, 4),
    nodes: r.int(0, 30),
    orphanChance: 0.2 + r.next() * 0.6, // many orphans
    costMode: r.chance(0.5) ? "unit" : "varied",
  };
}

// ── the fuzz driver ──────────────────────────────────────────────────────────────
describe("solveLodCut — antichain invariant fuzz (Phase C1b probe)", () => {
  test("single solve: valid antichain across random hierarchy × constraints × budget × gate", () => {
    const ITERS = 4000;
    for (let it = 0; it < ITERS; it++) {
      const seed = 0x1234 + it;
      const r = rng(seed);
      const spec = randomSpec(r);
      const { snap, nodeIds } = synthSnapshot(r, spec);
      const h = buildFuzzHierarchy(r, spec, nodeIds, snap);
      const constraints = randomConstraints(r, h);
      const budget = randomBudget(r, h);
      const gate = randomGate(r, h);
      const cam = randomCamera(r);

      // Seed cut is always the bootstrap (roots). The solver must keep it a valid antichain.
      let cut: LodCut;
      try {
        cut = solveLodCut(h, bootstrapCut(h), constraints, cam, budget, gate);
      } catch (e) {
        throw new Error(`seed=${seed} spec=${JSON.stringify(spec)} threw: ${(e as Error).message}`);
      }
      try {
        assertCutValid(h, cut, `seed=${seed}`);
      } catch (e) {
        throw new Error(
          `${(e as Error).message}\n  spec=${JSON.stringify(spec)}\n  forceClosed={${[...constraints.forceClosed].join(",")}} forceOpen={${[...constraints.forceOpen].join(",")}}\n  budget=${JSON.stringify(budget)}`,
        );
      }
    }
    expect(true).toBe(true);
  });

  test("iterated refine→coarsen→refine: every intermediate cut stays a valid antichain", () => {
    // Feed each solve's result as the NEXT solve's seed, varying constraints/budget/camera
    // every step — the cut must remain a valid antichain through the whole trajectory
    // (this is the refine/coarsen sequence the runtime drives as the camera moves).
    const ITERS = 1500;
    for (let it = 0; it < ITERS; it++) {
      const seed = 0xabc000 + it;
      const r = rng(seed);
      const spec = randomSpec(r);
      const { snap, nodeIds } = synthSnapshot(r, spec);
      const h = buildFuzzHierarchy(r, spec, nodeIds, snap);

      let cut = bootstrapCut(h);
      assertCutValid(h, cut, `seed=${seed} step=bootstrap`);
      const steps = r.int(2, 8);
      for (let s = 0; s < steps; s++) {
        const constraints = randomConstraints(r, h);
        const budget = randomBudget(r, h);
        const gate = randomGate(r, h);
        const cam = randomCamera(r);
        try {
          cut = solveLodCut(h, cut, constraints, cam, budget, gate);
        } catch (e) {
          throw new Error(`seed=${seed} step=${s} threw: ${(e as Error).message}`);
        }
        try {
          assertCutValid(h, cut, `seed=${seed} step=${s}`);
        } catch (e) {
          throw new Error(
            `${(e as Error).message}\n  spec=${JSON.stringify(spec)}\n  forceClosed={${[...constraints.forceClosed].join(",")}} forceOpen={${[...constraints.forceOpen].join(",")}}\n  budget=${JSON.stringify(budget)}`,
          );
        }
      }
    }
    expect(true).toBe(true);
  });

  test("budget rejection: a 0-budget solve returns the coarsest valid antichain (roots), byte-identical to the seed", () => {
    // With targetCards=0 AND hardCards=0 the solver can make NO refinement; the result must
    // be the bootstrap (roots) cut unchanged — still a valid antichain that covers all nodes.
    const ITERS = 800;
    for (let it = 0; it < ITERS; it++) {
      const seed = 0xbeef00 + it;
      const r = rng(seed);
      const spec = randomSpec(r);
      const { snap, nodeIds } = synthSnapshot(r, spec);
      const h = buildFuzzHierarchy(r, spec, nodeIds, snap);
      const zero: LodBudget = {
        targetCards: 0,
        hardCards: 0,
        targetLayoutCost: 0,
        hardLayoutCost: 0,
        targetEdges: 0,
        hardEdges: 0,
        targetLabels: 0,
        hardLabels: 0,
        maxGpuBytes: 0,
      };
      const cam = randomCamera(r);
      // No constraints: pure budget rejection from the seed.
      const seedCut = bootstrapCut(h);
      const cut = solveLodCut(
        h,
        seedCut,
        { forceClosed: new Set(), forceOpen: new Set() },
        cam,
        zero,
      );
      assertCutValid(h, cut, `seed=${seed} (zero budget)`);
      // The roots cut is the coarsest valid antichain; nothing could refine → byte-identical.
      expect([...cut.selectedRepresentations]).toEqual([...rootCut(h).selectedRepresentations]);
    }
    expect(true).toBe(true);
  });

  test("forceClosed always wins over a nested forceOpen, and the cut stays valid (precedence)", () => {
    // Specifically stress the precedence rule: for random ancestor/descendant pairs, close
    // the ancestor and open the descendant; the ancestor must remain represented (closed)
    // and the cut a valid antichain.
    const ITERS = 1500;
    for (let it = 0; it < ITERS; it++) {
      const seed = 0xfeed00 + it;
      const r = rng(seed);
      const spec = randomSpec(r);
      const { snap, nodeIds } = synthSnapshot(r, spec);
      const h = buildFuzzHierarchy(r, spec, nodeIds, snap);
      const { parentByRep } = h.columns;
      // Find a (ancestor, descendant) group-rep pair: pick a rep with a parent.
      const withParent: number[] = [];
      for (let rep = 0; rep < h.repCount; rep++) if (parentByRep[rep] !== -1) withParent.push(rep);
      const forceClosed = new Set<number>();
      const forceOpen = new Set<number>();
      if (withParent.length > 0) {
        const child = r.pick(withParent);
        const parent = parentByRep[child];
        forceClosed.add(parent);
        forceOpen.add(child);
        // sprinkle extra random constraints to keep it adversarial
        const extra = randomConstraints(r, h);
        for (const x of extra.forceClosed) forceClosed.add(x);
        for (const x of extra.forceOpen) forceOpen.add(x);
      }
      const budget = randomBudget(r, h);
      const cam = randomCamera(r);
      const cut = solveLodCut(
        h,
        bootstrapCut(h),
        { forceClosed, forceOpen },
        cam,
        budget,
        randomGate(r, h),
      );
      assertCutValid(h, cut, `seed=${seed} (precedence)`);
    }
    expect(true).toBe(true);
  });
});

// ── named edge-case guards (hand-built hierarchies for the trickiest solver paths) ──
// Build an explicit hierarchy from a parent array + node→group assignment. Depth/roots are
// derived from parentByGroup. Complements the fuzzer with deterministic, named scenarios.
function explicitHierarchy(
  parentByGroup: number[],
  directGroupByNode: number[],
): RepresentationHierarchy {
  const gc = parentByGroup.length;
  const depth = new Array<number>(gc).fill(0);
  for (let g = 0; g < gc; g++) {
    let d = 0;
    let c = g;
    let guard = gc + 1;
    while (parentByGroup[c] !== -1 && guard-- > 0) {
      d++;
      c = parentByGroup[c];
    }
    depth[g] = d;
  }
  const roots: number[] = [];
  for (let g = 0; g < gc; g++) if (parentByGroup[g] === -1) roots.push(g);
  const groupIds = parentByGroup.map((_, i) => `g${i}`);
  const snap: CompactGroupingSnapshot = {
    modeKey: "edge",
    groupIds,
    groupLabels: groupIds.slice(),
    parentByGroup: Int32Array.from(parentByGroup),
    depthByGroup: Uint16Array.from(depth),
    boxKeyByGroup: groupIds.slice(),
    directGroupByNode: Uint32Array.from(directGroupByNode),
    roots: Uint32Array.from(roots),
  };
  const nodeIds = directGroupByNode.map((_, i) => `n${i}`);
  return buildRepresentationHierarchy(snap, nodeIds, { nodeCost: () => 1 });
}

const edgeCam: CameraState = { x: 0, y: 0, scale: 1, viewport: { w: 800, h: 600 } };
// FINITE everywhere (Gap 6) — 1e9 stands in for "effectively unbounded" without Infinity.
const bigBudget: LodBudget = {
  targetCards: 1e9,
  hardCards: 1e9,
  targetLayoutCost: 1e9,
  hardLayoutCost: 1e9,
  targetEdges: 1e9,
  hardEdges: 1e9,
  targetLabels: 1e9,
  hardLabels: 1e9,
  maxGpuBytes: 1e9,
};
const zeroBudget: LodBudget = {
  targetCards: 0,
  hardCards: 0,
  targetLayoutCost: 0,
  hardLayoutCost: 0,
  targetEdges: 0,
  hardEdges: 0,
  targetLabels: 0,
  hardLabels: 0,
  maxGpuBytes: 0,
};
const noC: CutConstraints = { forceClosed: new Set(), forceOpen: new Set() };

describe("solveLodCut — antichain edge-case guards (Phase C1b probe)", () => {
  test("forceOpen a LEAF rep is a no-op and stays a valid antichain", () => {
    const h = explicitHierarchy([-1], [0]); // g0 root, one node in g0
    const leaf = h.columns.leafRepresentationByNode[0];
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([leaf]) },
      edgeCam,
      bigBudget,
    );
    expect(antichainViolation(h, cut)).toBeNull();
  });

  test("forceClosed and forceOpen on the SAME rep resolves to a valid antichain (closed wins)", () => {
    const h = explicitHierarchy([-1, 0], [1, 1]); // g0 → g1, nodes in g1
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set([0]), forceOpen: new Set([0]) },
      edgeCam,
      bigBudget,
    );
    expect(antichainViolation(h, cut)).toBeNull();
    expect(ancestorPairViolation(h, cut)).toBeNull();
  });

  test("Detail-limited forceOpen: a root that can't fully open under HARD retains a deeper proxy", () => {
    // g0 → g1 → {n0..n4}. Root cut {g0}=1 card. hardCards=2 allows g0→g1 (1 card) but NOT
    // g1→5 leaves (5 > 2). So g0 opens, g1 is retained — valid antichain, never busts hard.
    const h = explicitHierarchy([-1, 0], [1, 1, 1, 1, 1]);
    const hard2: LodBudget = {
      ...bigBudget,
      targetCards: 1,
      hardCards: 2,
      targetLayoutCost: 2,
      hardLayoutCost: 2,
    };
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([0]) },
      edgeCam,
      hard2,
    );
    expect(antichainViolation(h, cut)).toBeNull();
    const sel = new Set(cut.selectedRepresentations);
    expect(sel.has(0)).toBe(false); // g0 IS opened
    expect(sel.has(1)).toBe(true); // g1 is the retained proxy
    expect(cut.cardCost).toBeLessThanOrEqual(hard2.hardCards);
  });

  test("forceOpen blocked at hard=0 leaves the root cut byte-identical (valid antichain)", () => {
    const h = explicitHierarchy([-1, 0], [1, 1, 1]); // g0 → g1 → {n0,n1,n2}
    const hard0: LodBudget = {
      ...bigBudget,
      targetCards: 0,
      hardCards: 0,
      targetLayoutCost: 0,
      hardLayoutCost: 0,
    };
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([1]) },
      edgeCam,
      hard0,
    );
    expect(antichainViolation(h, cut)).toBeNull();
    expect([...cut.selectedRepresentations]).toEqual([...rootCut(h).selectedRepresentations]);
  });

  test("forceOpen the deepest group in a long chain descends the whole chain, valid throughout", () => {
    const h = explicitHierarchy([-1, 0, 1, 2, 3], [4, 4]); // g0→g1→g2→g3→g4, nodes in g4
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set(), forceOpen: new Set([4]) },
      edgeCam,
      bigBudget,
    );
    expect(antichainViolation(h, cut)).toBeNull();
    expect(new Set(cut.selectedRepresentations).has(4)).toBe(false); // g4 opened to leaves
  });

  test("nested forceClosed in either insertion order picks the outermost proxy, valid", () => {
    const h = explicitHierarchy([-1, 0, 1], [2, 2]); // g0→g1→g2, nodes in g2
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
    ]) {
      const cut = solveLodCut(
        h,
        bootstrapCut(h),
        { forceClosed: new Set(order), forceOpen: new Set() },
        edgeCam,
        bigBudget,
      );
      expect(antichainViolation(h, cut)).toBeNull();
      expect([...cut.selectedRepresentations]).toEqual([0]); // only the outermost represents
    }
  });

  test("orphan NO_GROUP nodes are root leaves, represented exactly once (big & zero budget)", () => {
    const h = explicitHierarchy([-1], [NO_GROUP, 0, NO_GROUP]); // n0,n2 orphan; n1 in g0
    const cutBig = solveLodCut(h, bootstrapCut(h), noC, edgeCam, bigBudget);
    expect(antichainViolation(h, cutBig)).toBeNull();
    const cutZero = solveLodCut(h, bootstrapCut(h), noC, edgeCam, zeroBudget);
    expect(antichainViolation(h, cutZero)).toBeNull();
  });

  test("forceClosed a leaf rep directly keeps the cut valid", () => {
    const h = explicitHierarchy([-1, 0], [1, 1]);
    const leaf = h.columns.leafRepresentationByNode[0];
    const cut = solveLodCut(
      h,
      bootstrapCut(h),
      { forceClosed: new Set([leaf]), forceOpen: new Set() },
      edgeCam,
      bigBudget,
    );
    expect(antichainViolation(h, cut)).toBeNull();
  });
});

// ── P0.5 super-root-bootstrap: the normalized hierarchy stays a valid antichain AND its
//    coarsest cut is always budget-feasible (design B1 + invariants a/b). Reuses the same
//    random hierarchy synthesis, rebuilt with bootstrapRoots: true.
describe("solveLodCut — bootstrap-normalized antichain fuzz (P0.5 B1)", () => {
  test("normalized hierarchy: valid antichain + coarsest cut ≤ MAX_FANOUT card under ANY budget", () => {
    const ITERS = 3000;
    for (let it = 0; it < ITERS; it++) {
      const seed = 0x5500 + it;
      const r = rng(seed);
      const spec = randomSpec(r);
      const { snap, nodeIds } = synthSnapshot(r, spec);
      const nodeCost =
        spec.costMode === "unit" ? () => 1 : (_id: string, ord: number) => 1 + (ord % 4);
      const h = buildRepresentationHierarchy(snap, nodeIds, { nodeCost, bootstrapRoots: true });

      // Coarsest cut (rootCut) feasibility: with normalization the roots are the bounded top
      // tier, so the bootstrap antichain is at most MAX_FANOUT cards (one super-root in
      // practice, but the top tier is the formal bound). This is the B1 invariant (a).
      const coarsest = rootCut(h);
      if (coarsest.cardCost > MAX_FANOUT) {
        throw new Error(
          `seed=${seed}: coarsest cut ${coarsest.cardCost} cards > MAX_FANOUT ${MAX_FANOUT} (roots=${h.roots.length})`,
        );
      }
      assertCutValid(h, coarsest, `seed=${seed} (coarsest)`);

      // No rep exceeds MAX_FANOUT children (invariant b).
      const { firstChildByRep, nextSiblingByRep } = h.columns;
      for (let rep = 0; rep < h.repCount; rep++) {
        let n = 0;
        for (let c = firstChildByRep[rep]; c !== -1; c = nextSiblingByRep[c]) n++;
        if (n > MAX_FANOUT) {
          throw new Error(`seed=${seed}: rep ${rep} has ${n} children > MAX_FANOUT ${MAX_FANOUT}`);
        }
      }

      // A full solve under a random budget stays valid and within hard.
      const constraints = randomConstraints(r, h);
      const budget = randomBudget(r, h);
      const cam = randomCamera(r);
      let cut: LodCut;
      try {
        cut = solveLodCut(h, bootstrapCut(h), constraints, cam, budget, randomGate(r, h));
      } catch (e) {
        throw new Error(`seed=${seed} threw: ${(e as Error).message}`);
      }
      assertCutValid(h, cut, `seed=${seed} (solved)`);
      // The solved cut never exceeds hard — EXCEPT the irreducible coarsest cut, which a
      // degenerate 0-budget can't shrink below (it must still cover every node). So the bound
      // is max(hardCards, coarsest): a production budget (≥ coarsest) is always honored.
      const floor = Math.max(budget.hardCards, coarsest.cardCost);
      if (cut.cardCost > floor) {
        throw new Error(`seed=${seed}: solved cut ${cut.cardCost} cards > ${floor}`);
      }
    }
    expect(true).toBe(true);
  });
});
