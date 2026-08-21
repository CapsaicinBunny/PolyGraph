// Parity / stress / cutover harness (design P4 — "Budget consolidation + parity / stress
// bench" + merge gate items 1, 5, 6, 7, 10, 13). The standalone bench (bench/rep-lod.ts) is a
// tuning harness and not CI-gated; the spec's merge gate requires the CUTOVER conditions to be
// asserted by an actual `bun test` job (item 12). This file is that gate. For EVERY grouping
// mode — Directory, Package, Community, facet, synthetic-None — it exercises the rep cut across
// zoom levels, a pan, and a post-filter mask, and asserts the non-negotiable cutover contract:
//
//   1. NO whole-graph rescan on a camera recut — the persistent runtime reuses the SAME
//      hierarchy object across zoom/pan (Gap 4 / merge-gate 1). A material change DOES rebuild.
//   2. NO global layout on a camera recut — globalRelayoutReason(prev,next) is null for a pure
//      camera move (merge-gate 10). A grouping/filter change DOES return a reason.
//   3. FINITE budgets respected — the solved cut's card count never exceeds the finite hardCards
//      ceiling, and every budget dimension is finite (merge-gate 7).
//   4. BOUNDED tiers — no rep parents more than MAX_FANOUT children (invariant b / merge-gate 13).
//   5. VALID antichain in every mode — every visible node represented exactly once. This is the
//      rep-cut-vs-C1a parity invariant: both paths must partition the visible node set into one
//      representative apiece (the property C1a's group cut guarantees and the new cut must match).
//
// These run on synthetic graphs (deterministic, fast) so the gate is reproducible in CI; the
// scale numbers live in bench/rep-lod.ts.

import { describe, expect, test } from "bun:test";
import {
  communityGrouping,
  directoryGrouping,
  facetGrouping,
  type GroupingHierarchy,
  packageGrouping,
  syntheticNoneGrouping,
} from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { MAX_FANOUT } from "./representation";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  buildSceneRepresentationCut,
  LOD_BUDGET,
  type RepLodResult,
} from "./lod-representation-cut";
import { globalRelayoutReason, type GlobalLayoutInputs } from "./global-relayout";
import type { CollapseIntent } from "./collapse-model";
import type { DimensionDescriptor } from "./dimensions";
import type { PackageManifest } from "./levels/types";
import { type GraphModel, makeEdge } from "./types";

// ── a synthetic repo with directory structure, packages, edges (→ communities), and a facet ──
// 6 dirs × 8 files, two manifests, an env facet, a sparse edge mesh so community detection finds
// real communities. Big enough to force intermediate tiers + multi-level cuts in every mode.
const dirs = ["app/api", "app/ui", "lib/core", "lib/util", "pkg/a/src", "pkg/b/src"];

function makeRepo(): GraphModel {
  const nodes = [];
  for (const d of dirs) {
    for (let i = 0; i < 8; i++) {
      const p = `${d}/f${i}.ts`;
      nodes.push({
        id: p,
        kind: "file" as const,
        label: `f${i}.ts`,
        filePath: p,
        line: 0,
        parentFile: p,
        facets: { env: [i % 2 === 0 ? "server" : "client"] },
      });
    }
  }
  const edges = [];
  // intra-dir chains (dense within a dir → community signal) + a few cross-dir links.
  for (const d of dirs) {
    for (let i = 0; i < 7; i++)
      edges.push(makeEdge(`${d}/f${i}.ts`, `${d}/f${i + 1}.ts`, "import"));
  }
  edges.push(makeEdge("app/api/f0.ts", "lib/core/f0.ts", "import"));
  edges.push(makeEdge("app/ui/f0.ts", "lib/util/f0.ts", "import"));
  edges.push(makeEdge("pkg/a/src/f0.ts", "pkg/b/src/f0.ts", "import"));
  return { nodes, edges };
}

const MANIFESTS: PackageManifest[] = [
  {
    id: "npm:pkg-a",
    name: "pkg-a",
    ecosystem: "npm",
    dir: "pkg/a",
    manifestPath: "pkg/a/package.json",
    declaredDeps: [],
  },
  {
    id: "npm:pkg-b",
    name: "pkg-b",
    ecosystem: "npm",
    dir: "pkg/b",
    manifestPath: "pkg/b/package.json",
    declaredDeps: [],
  },
];

const envFacet: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client" },
    { value: "server", label: "Server" },
  ],
  providerIds: ["core"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

function snapshotFor(mode: string, graph: GraphModel, nodeIds: readonly string[]) {
  let h: GroupingHierarchy | null;
  switch (mode) {
    case "directory":
      h = directoryGrouping(graph);
      break;
    case "package":
      h = packageGrouping(graph, MANIFESTS);
      break;
    case "community":
      h = communityGrouping(graph);
      break;
    case "facet:env":
      h = facetGrouping(graph, envFacet);
      break;
    case "none":
      h = syntheticNoneGrouping(graph);
      break;
    default:
      h = null;
  }
  if (!h) return null;
  return buildGroupingSnapshot(h, mode, nodeIds);
}

const MODES = ["directory", "package", "community", "facet:env", "none"] as const;

const vp: Viewport = { w: 1200, h: 800 };
const noIntent: CollapseIntent = new Map();

// Card budgets sourced from the ONE finite production model (P4); margin 0 (no cull slack).
const OPTS = {
  openPx: 200,
  maxCards: LOD_BUDGET.targetCards,
  nodeBudget: LOD_BUDGET.hardCards,
  margin: 0,
};

// World boxes: lay every group out in a coarse grid so the cut has on-screen geometry to
// measure. Reps the engine doesn't place fall back to stable bounds inside the cut.
function boxesFor(snap: ReturnType<typeof buildGroupingSnapshot>): Map<string, Box> {
  const m = new Map<string, Box>();
  snap.groupIds.forEach((_, i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    m.set(snap.boxKeyByGroup[i], { x: col * 1200, y: row * 1200, w: 1000, h: 1000 });
  });
  return m;
}

/** A pure camera-move GlobalLayoutInputs pair (everything material identical). */
function cameraOnlyInputs(mode: string): { prev: GlobalLayoutInputs; next: GlobalLayoutInputs } {
  const base: GlobalLayoutInputs = {
    graphVersion: "v1",
    filterSignature: "f0",
    groupingMode: mode,
    direction: "LR",
    layoutEngine: "smart",
    layoutOptionsHash: "h0",
    explicitRelayoutNonce: 0,
    envelopeExhaustedNonce: 0,
  };
  return { prev: base, next: { ...base } };
}

/** Every visible node represented exactly once (the antichain / parity invariant). */
function assertExactlyOnce(r: RepLodResult, visibleCount: number) {
  const { hierarchy, cut } = r;
  const selected = new Set(cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = hierarchy.columns;
  let covered = 0;
  for (let i = 0; i < leafRepresentationByNode.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = hierarchy.repCount + 1;
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    // A visible node is covered exactly once; a detached (filtered-out) node is covered zero
    // times (its leaf rep sits under DETACHED_REP, never reached by the cut).
    if (hits === 1) covered++;
    else expect(hits).toBeLessThanOrEqual(1); // never double-represented
  }
  expect(covered).toBe(visibleCount);
}

/** No rep exceeds the fan-out bound (invariant b / bounded tiers). */
function assertBoundedFanout(r: RepLodResult) {
  const { firstChildByRep, nextSiblingByRep } = r.hierarchy.columns;
  for (let rep = 0; rep < r.hierarchy.repCount; rep++) {
    let n = 0;
    let c = firstChildByRep[rep];
    let guard = r.hierarchy.repCount + 1;
    while (c !== -1 && guard-- > 0) {
      n++;
      c = nextSiblingByRep[c];
    }
    expect(n).toBeLessThanOrEqual(MAX_FANOUT);
  }
}

/** The solved cut honors the FINITE ceilings (cards = antichain width). */
function assertFiniteBudget(r: RepLodResult) {
  const b = r.budget;
  for (const v of [
    b.targetCards,
    b.hardCards,
    b.targetLayoutCost,
    b.hardLayoutCost,
    b.targetEdges,
    b.hardEdges,
    b.targetLabels,
    b.hardLabels,
    b.maxGpuBytes,
  ]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  // The committed antichain never exceeds the finite hard card ceiling.
  expect(r.cut.selectedRepresentations.length).toBeLessThanOrEqual(b.hardCards);
}

describe("P4 parity / stress / cutover harness — all modes × zoom × pan × filtered", () => {
  const graph = makeRepo();
  const nodeIds = graph.nodes.map((n) => n.id);

  for (const mode of MODES) {
    const snap = snapshotFor(mode, graph, nodeIds);
    if (!snap) throw new Error(`mode ${mode} produced no snapshot`);
    const boxes = () => boxesFor(snap);

    // The cameras: zoomed-out (coarse), zoomed-in (refine), and a PAN of the zoomed-in camera.
    const camOut: Camera = { x: 600, y: 600, scale: 0.08 };
    const camIn: Camera = { x: 600, y: 600, scale: 0.9 };
    const camPan: Camera = { x: 2400, y: 600, scale: 0.9 }; // same zoom, panned to another region

    function run(cam: Camera, runtime?: RepLodResult["repRuntime"]): RepLodResult {
      return buildSceneRepresentationCut({
        snapshot: snap!,
        nodeIds,
        boxes: boxes(),
        cam,
        vp,
        intent: noIntent,
        options: OPTS,
        runtime,
      });
    }

    test(`${mode}: valid antichain + bounded tiers + finite budget at every zoom`, () => {
      for (const cam of [camOut, camIn]) {
        const r = run(cam);
        assertExactlyOnce(r, nodeIds.length);
        assertBoundedFanout(r);
        assertFiniteBudget(r);
      }
    });

    test(`${mode}: camera recut (zoom→pan) reuses the SAME hierarchy — no whole-graph rescan`, () => {
      // First solve builds the persistent runtime; subsequent recuts must REUSE it.
      const first = run(camIn);
      const zoomed = run(camOut, first.repRuntime);
      const panned = run(camPan, zoomed.repRuntime);
      // The hierarchy object is reused byte-for-byte across the camera recuts (Gap 4).
      expect(zoomed.repRuntime.hierarchy).toBe(first.repRuntime.hierarchy);
      expect(panned.repRuntime.hierarchy).toBe(first.repRuntime.hierarchy);
      expect(zoomed.repRuntime.signature).toBe(first.repRuntime.signature);
      // And the cut stays a valid antichain after the pan (pan-end visibility recut, Gap 8).
      assertExactlyOnce(panned, nodeIds.length);
    });

    test(`${mode}: pure camera move triggers NO global relayout`, () => {
      const { prev, next } = cameraOnlyInputs(mode);
      expect(globalRelayoutReason(prev, next)).toBeNull();
    });

    test(`${mode}: filtered graph — cut covers exactly the visible nodes, still bounded + finite`, () => {
      // Hide the second half of every directory (post-filter mask over ordinals).
      const visible = (ord: number) => ord % 2 === 0;
      const visibleCount = nodeIds.filter((_, i) => visible(i)).length;
      const r = buildSceneRepresentationCut({
        snapshot: snap!,
        nodeIds,
        boxes: boxes(),
        cam: camIn,
        vp,
        intent: noIntent,
        options: OPTS,
        visibleNode: visible,
        filterSignature: "half",
      });
      assertExactlyOnce(r, visibleCount); // only the visible nodes are represented
      assertBoundedFanout(r);
      assertFiniteBudget(r);
    });
  }

  test("a grouping-mode change DOES rebuild the hierarchy (control: recut reuse is not unconditional)", () => {
    const dirSnap = snapshotFor("directory", graph, nodeIds)!;
    const comSnap = snapshotFor("community", graph, nodeIds)!;
    const common = {
      nodeIds,
      cam: { x: 600, y: 600, scale: 0.9 } as Camera,
      vp,
      intent: noIntent,
      options: OPTS,
    };
    const a = buildSceneRepresentationCut({
      ...common,
      snapshot: dirSnap,
      boxes: boxesFor(dirSnap),
    });
    // Pass the directory runtime but a DIFFERENT mode's snapshot → material change → rebuild.
    const b = buildSceneRepresentationCut({
      ...common,
      snapshot: comSnap,
      boxes: boxesFor(comSnap),
      runtime: a.repRuntime,
    });
    expect(b.repRuntime.hierarchy).not.toBe(a.repRuntime.hierarchy);
    expect(b.repRuntime.signature).not.toBe(a.repRuntime.signature);
  });

  test("a grouping-mode change DOES return a global-relayout reason (control)", () => {
    const { prev } = cameraOnlyInputs("directory");
    const next: GlobalLayoutInputs = { ...prev, groupingMode: "community" };
    expect(globalRelayoutReason(prev, next)).toBe("grouping-mode");
  });
});
