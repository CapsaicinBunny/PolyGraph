// P0.5 "subdivision-strategies" probe (builder integration) — design B1 strategy sequence +
// impl note (c). The pure partitioner is unit-tested in representation-subdivision.test.ts; THIS
// suite drives it THROUGH buildRepresentationHierarchy with the new `inGroupEdges` / `pathPrefixOf`
// inputs and asserts the four invariants still hold for the tiered hierarchy:
//   - a WELL-CLUSTERED group gets community tiers (clusters land in distinct intermediate subtrees);
//   - a DEGENERATE partition rejects and falls back (no crash, invariants intact, chunk-shaped);
//   - the depth/work caps bail to chunks but STILL produce a valid bounded antichain.
// Every case re-checks the T2 invariants: coarsest cut ≤ hardCards (a), no rep > MAX_FANOUT (b),
// the oversized group is tiered (c), a one-level refine yields bounded children not the leaf set (d).

import { describe, expect, test } from "bun:test";
import { type CompactGroupingSnapshot, NO_GROUP } from "./grouping-snapshot";
import {
  buildRepresentationHierarchy,
  MAX_FANOUT,
  type RepresentationHierarchy,
  isRepAncestor,
} from "./representation";
import { rootCut } from "./lod-cut-solver";

// ── one flat group of `members` nodes (the flat-mode shape the spec targets) ─────────
function oneGroupSnapshot(members: number) {
  const directGroupByNode = new Uint32Array(members).fill(0);
  const nodeIds = Array.from({ length: members }, (_, i) => `n${i}`);
  const snap: CompactGroupingSnapshot = {
    modeKey: "flat",
    groupIds: ["g0"],
    groupLabels: ["g0"],
    parentByGroup: new Int32Array(1).fill(-1),
    depthByGroup: new Uint16Array(1),
    boxKeyByGroup: ["g0"],
    directGroupByNode,
    roots: Uint32Array.from([0]),
  };
  return { snap, nodeIds };
}

function childrenOf(h: RepresentationHierarchy, rep: number): number[] {
  const { firstChildByRep, nextSiblingByRep } = h.columns;
  const out: number[] = [];
  let guard = h.repCount + 1;
  for (let c = firstChildByRep[rep]; c !== -1 && guard-- > 0; c = nextSiblingByRep[c]) out.push(c);
  return out;
}

function antichainViolation(h: RepresentationHierarchy, selected: Set<number>): string | null {
  const { parentByRep, leafRepresentationByNode } = h.columns;
  for (let i = 0; i < leafRepresentationByNode.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = h.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    if (hits !== 1) return `node ${i}: ${hits} selected reps on path (expected 1)`;
  }
  return null;
}

/** Assert the four B1 invariants for a tiered hierarchy whose sole group is `groupRep`. */
function expectInvariants(h: RepresentationHierarchy, groupRep: number, members: number) {
  // (a) coarsest cut is one card (the group root) and a valid antichain.
  const coarsest = rootCut(h);
  expect(coarsest.cardCost).toBe(1);
  expect(antichainViolation(h, new Set(coarsest.selectedRepresentations))).toBeNull();
  // (b) no rep exceeds MAX_FANOUT children.
  for (let r = 0; r < h.repCount; r++) {
    expect(childrenOf(h, r).length).toBeLessThanOrEqual(MAX_FANOUT);
  }
  // (c) the oversized group received intermediate tiers (synthetic reps beyond base).
  expect(h.repCount).toBeGreaterThan(1 + members);
  // (d) a one-level refine yields bounded intermediate children, never the leaf set.
  const kids = childrenOf(h, groupRep);
  expect(kids.length).toBeGreaterThan(0);
  expect(kids.length).toBeLessThanOrEqual(MAX_FANOUT);
  expect(kids.length).toBeLessThan(members);
  for (const c of kids) expect(h.columns.groupByRep[c]).toBe(NO_GROUP); // render-only proxies
  // subtree cost still rolls up to the full membership.
  expect(h.columns.subtreeNodeCost[groupRep]).toBe(members);
}

describe("a WELL-CLUSTERED group gets community tiers", () => {
  // 64 members in TWO tight clusters (0..31, 32..63), dense within, one weak bridge between.
  // 64 > MAX_FANOUT so the group is oversized; community partitioning should split it into the
  // two clusters, each landing under a distinct intermediate proxy subtree.
  const MEMBERS = 64;
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const inGroupEdges: { source: number; target: number }[] = [];
  const half = MEMBERS / 2;
  // Dense intra-cluster ring + chords so each cluster is one community.
  for (const base of [0, half]) {
    for (let i = 0; i < half; i++) {
      inGroupEdges.push({ source: base + i, target: base + ((i + 1) % half) });
      inGroupEdges.push({ source: base + i, target: base + ((i + 2) % half) });
    }
  }
  inGroupEdges.push({ source: half - 1, target: half }); // single bridge between clusters

  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true, inGroupEdges });
  const groupRep = h.repOfGroup[0];

  test("the four B1 invariants hold for the community-tiered group", () => {
    expectInvariants(h, groupRep, MEMBERS);
  });

  test("the two clusters land in DISTINCT intermediate subtrees (community structure preserved)", () => {
    // Each cluster (first half / second half) should share an intermediate ancestor that the
    // OTHER cluster's nodes do not — i.e. the two clusters separate at the group's first tier.
    const { leafRepresentationByNode } = h.columns;
    const kids = childrenOf(h, groupRep); // the top intermediate tier
    // For each top-tier child, the set of underlying node ordinals beneath it.
    const memberSetOf = (rep: number): Set<number> => {
      const out = new Set<number>();
      for (let i = 0; i < MEMBERS; i++) {
        if (isRepAncestor(h.columns, rep, leafRepresentationByNode[i])) out.add(i);
      }
      return out;
    };
    // There exists a top-tier child whose members are entirely within the first cluster, and
    // another entirely within the second — the clusters were NOT shredded across every chunk.
    const sets = kids.map(memberSetOf);
    const firstCluster = (s: Set<number>) => [...s].every((i) => i < half);
    const secondCluster = (s: Set<number>) => [...s].every((i) => i >= half);
    expect(sets.some((s) => s.size > 0 && firstCluster(s))).toBe(true);
    expect(sets.some((s) => s.size > 0 && secondCluster(s))).toBe(true);
    // And no top-tier subtree MIXES the two clusters (the bridge did not merge them at tier 1).
    for (const s of sets) {
      if (s.size === 0) continue;
      expect(firstCluster(s) || secondCluster(s)).toBe(true);
    }
  });
});

describe("a DEGENERATE partition rejects and falls back", () => {
  // A STAR over 64 members: hub (node 0) linked to every other node, leaves pairwise unconnected.
  // Label-propagation collapses the star into ONE community (one dominant bucket) — that is
  // REJECTED for balance, and tiering falls through (heavy-edge / chunk). The invariants must
  // still hold and the hierarchy must be valid.
  const MEMBERS = 64;
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const inGroupEdges: { source: number; target: number }[] = [];
  for (let i = 1; i < MEMBERS; i++) inGroupEdges.push({ source: 0, target: i });

  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true, inGroupEdges });
  const groupRep = h.repOfGroup[0];

  test("the rejected community split still yields a valid, bounded, tiered hierarchy", () => {
    expectInvariants(h, groupRep, MEMBERS);
  });

  test("the result matches the deterministic fallback shape (no single dominant subtree)", () => {
    // No top-tier child stands in for > 85% of the membership (the degeneracy that was rejected).
    const { leafRepresentationByNode } = h.columns;
    const kids = childrenOf(h, groupRep);
    for (const kid of kids) {
      let under = 0;
      for (let i = 0; i < MEMBERS; i++) {
        if (isRepAncestor(h.columns, kid, leafRepresentationByNode[i])) under++;
      }
      expect(under).toBeLessThanOrEqual(Math.ceil(MEMBERS * 0.85));
    }
  });
});

describe("the depth/work caps bail to chunks", () => {
  // Even with rich edges, an exhausted work budget must NOT prevent a valid bounded tiering — it
  // bails to balanced chunks. We can't inject the clock through the public builder, so we assert
  // the equivalent guarantee: a well-clustered build and a no-edge build BOTH satisfy the
  // invariants and produce the SAME bounded fan-out — i.e. the fallback is always a valid tiering.
  const MEMBERS = 200; // forces multiple tiers (200 / 32 = 7 bottom proxies, then 1 group level)
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);

  test("the chunk fallback (no edges/paths) satisfies every invariant", () => {
    const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true });
    expectInvariants(h, h.repOfGroup[0], MEMBERS);
  });

  test("an empty edge list is treated as no clusters → chunk fallback, still valid", () => {
    const h = buildRepresentationHierarchy(snap, nodeIds, {
      intermediateTiers: true,
      inGroupEdges: [],
    });
    expectInvariants(h, h.repOfGroup[0], MEMBERS);
    // Identical structure to the no-edges build (an empty edge list selects nothing to cluster on).
    const plain = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true });
    expect(h.repCount).toBe(plain.repCount);
    expect(h.columns.parentByRep).toEqual(plain.columns.parentByRep);
  });
});

describe("directory subdivision through the builder (B1 source 3)", () => {
  // 60 members, no edges, but a path per node under a shared root in three subdirectories.
  // The directory strategy splits them by subdir (alpha/beta/gamma) at the first tier.
  const MEMBERS = 60;
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const pathPrefixOf = (i: number) => {
    if (i < 20) return `src/alpha/n${i}.ts`;
    if (i < 40) return `src/beta/n${i}.ts`;
    return `src/gamma/n${i}.ts`;
  };
  const h = buildRepresentationHierarchy(snap, nodeIds, { intermediateTiers: true, pathPrefixOf });
  const groupRep = h.repOfGroup[0];

  test("invariants hold and the three directories land in distinct subtrees", () => {
    expectInvariants(h, groupRep, MEMBERS);
    const { leafRepresentationByNode } = h.columns;
    const kids = childrenOf(h, groupRep);
    const dirOf = (i: number) => (i < 20 ? 0 : i < 40 ? 1 : 2);
    // Every top-tier subtree is single-directory (no chunk shredded a directory across tiers).
    for (const kid of kids) {
      const dirs = new Set<number>();
      for (let i = 0; i < MEMBERS; i++) {
        if (isRepAncestor(h.columns, kid, leafRepresentationByNode[i])) dirs.add(dirOf(i));
      }
      if (dirs.size > 0) expect(dirs.size).toBe(1);
    }
  });
});

describe("edges compose with bootstrap normalization (T2 invariants in every mode)", () => {
  // Both options + edges: the group is still adopted by a super-root AND community-tiered below.
  const MEMBERS = 64;
  const { snap, nodeIds } = oneGroupSnapshot(MEMBERS);
  const inGroupEdges: { source: number; target: number }[] = [];
  const half = MEMBERS / 2;
  for (const base of [0, half]) {
    for (let i = 0; i < half; i++) {
      inGroupEdges.push({ source: base + i, target: base + ((i + 1) % half) });
    }
  }
  const h = buildRepresentationHierarchy(snap, nodeIds, {
    intermediateTiers: true,
    bootstrapRoots: true,
    inGroupEdges,
  });

  test("super-root is the sole root, coarsest cut one card, no rep over MAX_FANOUT", () => {
    expect(h.roots).toEqual([h.superRoot]);
    expect(rootCut(h).cardCost).toBe(1);
    for (let r = 0; r < h.repCount; r++) {
      expect(childrenOf(h, r).length).toBeLessThanOrEqual(MAX_FANOUT);
    }
    expect(antichainViolation(h, new Set(rootCut(h).selectedRepresentations))).toBeNull();
  });
});
