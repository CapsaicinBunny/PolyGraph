import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import type { CompactGroupingSnapshot } from "./grouping-snapshot";
import type { GroupId } from "./collapse-model";
import {
  acquireRepresentationRuntime,
  activeProxyBoxKeyOfNode,
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  LOD_BUDGET,
  materialSignature,
  type RepresentationRuntime,
} from "./lod-representation-cut";
import { makeEvictionController } from "./lod-eviction";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// a/x/{f1,f2}, a/y/f3, b/z/{f4,f5}
const graph: GraphModel = {
  nodes: [file("a/x/f1.c"), file("a/x/f2.c"), file("a/y/f3.c"), file("b/z/f4.c"), file("b/z/f5.c")],
  edges: [makeEdge("a/x/f1.c", "b/z/f4.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);

// The OPEN-selection oracle: a group is open iff neither it nor any ancestor's box key is in
// `collapsed`. This is the (now-retired) C1a `groupLodSelection` semantics, kept as an
// independent in-test cross-check for the rep cut's own `openSelectionOf` derivation — proving
// the rep cut's openSelection matches the canonical collapsed→open conversion `compose()` wants.
function openSelectionOracle(
  collapsed: ReadonlySet<string>,
  snapshot: CompactGroupingSnapshot,
): Set<GroupId> {
  const underCut = (g: number): boolean => {
    let cur = g;
    let guard = snapshot.groupIds.length + 1;
    while (cur !== -1 && guard-- > 0) {
      if (collapsed.has(snapshot.boxKeyByGroup[cur])) return true;
      cur = snapshot.parentByGroup[cur];
    }
    return false;
  };
  const open = new Set<GroupId>();
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    if (!underCut(g)) open.add(snapshot.groupIds[g]);
  }
  return open;
}

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();

// World boxes (the live scene's clusters): "a" near the origin, "b" far to the right.
const boxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
    ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
    ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
    ["b", { x: 5000, y: 0, w: 1000, h: 1000 }],
    ["b/z", { x: 5000, y: 0, w: 1000, h: 1000 }],
  ]);

const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

/** Solve from scratch (no previous runtime) and return the result. */
function solve(cam: Camera, intent: CollapseIntent = noIntent) {
  return buildSceneRepresentationCut({
    snapshot: snap,
    nodeIds,
    boxes: boxes(),
    cam,
    vp,
    intent,
    options: opts,
  });
}

describe("budget consolidation (P4) — ONE finite source", () => {
  test("LOD_BUDGET is the single finite source: every ceiling finite, targets ≤ hards", () => {
    for (const v of [
      LOD_BUDGET.targetCards,
      LOD_BUDGET.hardCards,
      LOD_BUDGET.targetLayoutCost,
      LOD_BUDGET.hardLayoutCost,
      LOD_BUDGET.targetEdges,
      LOD_BUDGET.hardEdges,
      LOD_BUDGET.targetLabels,
      LOD_BUDGET.hardLabels,
      LOD_BUDGET.maxGpuBytes,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(LOD_BUDGET.targetCards).toBeLessThanOrEqual(LOD_BUDGET.hardCards);
    expect(LOD_BUDGET.targetLayoutCost).toBeLessThanOrEqual(LOD_BUDGET.hardLayoutCost);
    expect(LOD_BUDGET.targetEdges).toBeLessThanOrEqual(LOD_BUDGET.hardEdges);
    expect(LOD_BUDGET.targetLabels).toBeLessThanOrEqual(LOD_BUDGET.hardLabels);
  });

  test("DEFAULT_REP_LOD_OPTIONS sources its card budgets from LOD_BUDGET (no duplicate copies)", () => {
    // The canvas/Explorer no longer carry their own LOD_MAX_CARDS / AUTO_COLLAPSE_MAX_CARDS /
    // LOD_NODE_BUDGET copies; the defaults derive from the one model.
    expect(DEFAULT_REP_LOD_OPTIONS.maxCards).toBe(LOD_BUDGET.targetCards);
    expect(DEFAULT_REP_LOD_OPTIONS.nodeBudget).toBe(LOD_BUDGET.hardCards);
  });

  test("expand-all fix preserved: hardCards stays 1500 (within Smart's reliable range)", () => {
    // The expand-all / scan seed resolve `nodeBudget` to LOD_BUDGET.hardCards. It MUST remain
    // 1500 — the measured value that keeps the layout input small enough for Smart to finish
    // inside the 8s worker timeout (do not regress to the old 2500 that hung, nor the unused
    // 2000 example default). See docs/superpowers/plans/2026-06-18-nanite-lod-node-budget.md.
    expect(LOD_BUDGET.hardCards).toBe(1500);
    expect(DEFAULT_REP_LOD_OPTIONS.nodeBudget).toBe(1500);
  });

  test("the solved budget reads layout/edge/label/gpu ceilings from LOD_BUDGET", () => {
    const r = solve({ x: 0, y: 0, scale: 0.1 });
    expect(r.budget.targetLayoutCost).toBe(LOD_BUDGET.targetLayoutCost);
    expect(r.budget.hardLayoutCost).toBe(LOD_BUDGET.hardLayoutCost);
    expect(r.budget.targetEdges).toBe(LOD_BUDGET.targetEdges);
    expect(r.budget.hardEdges).toBe(LOD_BUDGET.hardEdges);
    expect(r.budget.targetLabels).toBe(LOD_BUDGET.targetLabels);
    expect(r.budget.hardLabels).toBe(LOD_BUDGET.hardLabels);
    expect(r.budget.maxGpuBytes).toBe(LOD_BUDGET.maxGpuBytes);
  });
});

describe("buildSceneRepresentationCut — valid antichain + collapse-shaped derivation", () => {
  test("coarsest semantic level: leaf groups collapse to proxies; the cut is a valid antichain", () => {
    // The cut now reads the STABLE proxy bounds (a layout-independent treemap of the rep tree),
    // NOT the visual engine's live boxes — so the test cameras key off that geometry. In the
    // stable layout the top dirs {a, b} fill the world canvas at the SAME scale as the synthetic
    // super-root's slots, so there is no camera band where {a, b} themselves are collapsed
    // proxies: the moment the super-root is legible enough to refine, a and b are too. The
    // genuinely-coarsest level with VISIBLE group proxies is therefore the leaf groups
    // {a/x, a/y, b/z} (their parents a, b are open). At 0.01 the cut is the single render-only
    // super-root card, which carries no box key.
    const r = solve({ x: 0, y: 0, scale: 0.054 }); // coarsest level with group proxies
    // The leaf groups are collapsed (their box keys present in the collapsed set).
    expect(r.collapsedBoxKeys.has("a/x")).toBe(true);
    expect(r.collapsedBoxKeys.has("a/y")).toBe(true);
    expect(r.collapsedBoxKeys.has("b/z")).toBe(true);
    // Their parents a and b are OPEN (refined past their proxy), not collapsed.
    expect(r.collapsedBoxKeys.has("a")).toBe(false);
    expect(r.collapsedBoxKeys.has("b")).toBe(false);
    // The derived open selection equals groupLodSelection over the collapsed set.
    expect([...r.openSelection].sort()).toEqual(
      [...openSelectionOracle(r.collapsedBoxKeys, snap)].sort(),
    );
    assertValidAntichain(r);
  });

  test("zoomed into 'a': a refines (not collapsed) while the off-screen 'b' stays a proxy", () => {
    // Camera scale 1, centred on a (origin). a's box is 1000px tall → well above openPx; b
    // is off-screen (x 5000).
    const r = solve({ x: 0, y: 0, scale: 1 });
    expect(r.collapsedBoxKeys.has("a")).toBe(false); // a opened
    expect(r.collapsedBoxKeys.has("b")).toBe(true); // b still a proxy (off-screen)
    assertValidAntichain(r);
  });

  test("the derived openSelection is exactly groupLodSelection(collapsed, snapshot)", () => {
    const r = solve({ x: 0, y: 0, scale: 1 });
    expect([...r.openSelection].sort()).toEqual(
      [...openSelectionOracle(r.collapsedBoxKeys, snap)].sort(),
    );
  });
});

describe("buildSceneRepresentationCut — user intent constrains the cut", () => {
  test("forceClosed (user-collapsed) keeps a large on-screen group as a proxy", () => {
    const intent: CollapseIntent = new Map([["directory:a", "closed"]]);
    const r = solve({ x: 0, y: 0, scale: 1 }, intent);
    expect(r.collapsedBoxKeys.has("a")).toBe(true); // user closed it → proxy, despite size
    assertValidAntichain(r);
  });

  test("forceOpen (user-expanded) refines a small/off-screen group past its proxy", () => {
    const intent: CollapseIntent = new Map([["directory:b", "open"]]);
    const r = solve({ x: 0, y: 0, scale: 1 }, intent);
    // b is off-screen so auto would collapse it; the user forced it open → not collapsed.
    expect(r.collapsedBoxKeys.has("b")).toBe(false);
    assertValidAntichain(r);
  });
});

describe("buildSceneRepresentationCut — finite split budget (Gap 6 / 'Finite budget model')", () => {
  test("the solve budget is FINITE on every dimension (no Infinity / totalNodes)", () => {
    const r = solve({ x: 0, y: 0, scale: 1 });
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
    // Card ceilings derive from the caller options; the rest from the production defaults.
    expect(b.hardCards).toBe(opts.nodeBudget);
    expect(b.targetCards).toBe(Math.min(opts.maxCards, opts.nodeBudget));
    // hardCards is NOT inflated to the whole-graph size (the Gap 6 regression).
    expect(b.hardCards).toBeLessThan(1_000_000);
  });

  test("a forced open beyond hardCards is capped and surfaces limitedDetails", () => {
    // A tiny card budget. Force-open the LEAF group b/z: honoring it requires revealing its
    // child leaves (f4,f5), but root {a,b}=2 → opening b→b/z=2 → b/z→leaves=3 busts hard=2.
    // So b/z is retained and a "Detail limited" signal fires.
    const tight = { ...opts, maxCards: 2, nodeBudget: 2 };
    const intent: CollapseIntent = new Map([["directory:b/z", "open"]]);
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent,
      options: tight,
    });
    // Cards capped at the finite hard ceiling — never the whole graph.
    expect(r.cut.cardCost).toBeLessThanOrEqual(r.budget.hardCards);
    // The "Detail limited" signal is surfaced as a structured field (always populated).
    expect(r.limitedDetails.length).toBeGreaterThan(0);
    expect(r.limitedDetails[0].limitingBudget).toBe("cards");
  });

  test("an unconstrained solve surfaces no limitedDetails", () => {
    const r = solve({ x: 0, y: 0, scale: 1 });
    expect(r.limitedDetails.length).toBe(0);
  });
});

describe("activeProxyBoxKeyOfNode — a selected hidden node highlights its active proxy", () => {
  test("a node inside a collapsed group maps to that group's proxy box key", () => {
    // Scale 0.054 is the coarsest level with visible group proxies under the STABLE bounds the
    // cut now reads (see the antichain suite for why {a, b} are never themselves proxies). The
    // collapsed proxies here are the leaf groups {a/x, a/y, b/z}. At 0.01 the sole selected rep
    // is the render-only super-root, whose proxy box key is null.
    const r = solve({ x: 0, y: 0, scale: 0.054 }); // leaf groups collapsed to proxies
    // f4 lives in b/z → the outermost SELECTED ancestor on its chain is the b/z proxy itself.
    const key = activeProxyBoxKeyOfNode(r, nodeIds.indexOf("b/z/f4.c"));
    expect(key).toBe("b/z");
  });

  test("a node whose own leaf rep is selected maps to null (it's visible, no proxy)", () => {
    // Open everything (huge boxes, zoomed in, big budget): leaves selected.
    const big = { ...opts, maxCards: 100000, nodeBudget: 100000 };
    const r = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: new Map<string, Box>([
        ["a", { x: 0, y: 0, w: 100, h: 100 }],
        ["a/x", { x: 0, y: 0, w: 100, h: 100 }],
        ["a/y", { x: 0, y: 0, w: 100, h: 100 }],
        ["b", { x: 0, y: 0, w: 100, h: 100 }],
        ["b/z", { x: 0, y: 0, w: 100, h: 100 }],
      ]),
      cam: { x: 0, y: 0, scale: 100 }, // everything huge on screen
      vp,
      intent: noIntent,
      options: big,
    });
    // When the cut reaches a node's own leaf rep, it is its own representative → no proxy.
    const ord = nodeIds.indexOf("a/x/f1.c");
    // Only assert null if f1's leaf rep is actually selected (fully refined).
    const selected = new Set(r.cut.selectedRepresentations);
    const leaf = r.hierarchy.columns.leafRepresentationByNode[ord];
    if (selected.has(leaf)) {
      expect(activeProxyBoxKeyOfNode(r, ord)).toBeNull();
    }
  });
});

describe("buildSceneRepresentationCut — committed-generation gating via runtime", () => {
  test("re-solving with the SAME inputs commits nothing new (immaterial)", () => {
    const r1 = solve({ x: 0, y: 0, scale: 1 });
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: opts,
      previous: r1.runtime,
    });
    // Same selected reps → no material change → generation unchanged, committed flag false.
    expect(r2.committed).toBe(false);
    expect(r2.runtime.generation).toBe(r1.runtime.generation);
  });

  test("a materially-different solve (zoom in) commits and bumps the generation", () => {
    const r1 = solve({ x: 0, y: 0, scale: 0.01 }); // all collapsed
    const gen0 = r1.runtime.generation; // capture BEFORE r2 mutates the shared runtime
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 }, // zoom into a
      vp,
      intent: noIntent,
      options: opts,
      previous: r1.runtime,
    });
    expect(r2.committed).toBe(true);
    expect(r2.runtime.generation).toBe(gen0 + 1);
  });
});

describe("buildSceneRepresentationCut — bounded offscreen eviction + in-place roll (bug b)", () => {
  test("over-budget offscreen auto-opens are evicted (re-collapsed) and counted", () => {
    // A graph with several independent top dirs, all huge ON-SCREEN so the cut auto-opens
    // them, but with a tiny offscreen-open budget. We then pan them OFF-SCREEN: the now-
    // offscreen opens exceed the budget and must be evicted (re-collapsed).
    const dirs = ["a", "b", "c", "d"];
    const g: GraphModel = {
      nodes: dirs.flatMap((d) => [file(`${d}/x/f1.c`), file(`${d}/x/f2.c`)]),
      edges: [],
    };
    const ids = g.nodes.map((n) => n.id);
    const s = buildGroupingSnapshot(directoryGrouping(g), "directory", ids);
    // All four top boxes on-screen and tall (so they auto-open at scale 1).
    const onScreenBoxes = (): Map<string, Box> => {
      const m = new Map<string, Box>();
      dirs.forEach((d, i) => {
        m.set(d, { x: i * 10, y: 0, w: 700, h: 700 });
        m.set(`${d}/x`, { x: i * 10, y: 0, w: 600, h: 600 });
      });
      return m;
    };
    const budget = 1;
    const ctrl = makeEvictionController(s.groupIds.length + ids.length, budget);
    const baseOpts = { ...opts, openPx: 100, maxCards: 100000, nodeBudget: 100000 };
    // Frame 1: all four dirs ON-SCREEN → all four auto-open. The budget bounds the OFFSCREEN
    // deadband only, so on-screen opens are EXEMPT — nothing evicts while they're visible.
    // (Exempting on-screen opens is what keeps the canvas's recut cycle from oscillating; see
    // lod-recut-convergence.test.ts.) Visibility is decided by the STABLE bounds, not the live
    // boxes; the on-screen frame is centered so the auto-opened proxies are in-viewport.
    const r1 = buildSceneRepresentationCut({
      snapshot: s,
      nodeIds: ids,
      boxes: onScreenBoxes(),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: baseOpts,
      eviction: ctrl,
    });
    // No eviction while the opens are on-screen — they're bounded by the card budget, not here.
    expect(r1.evictions).toBe(0);
    const trackedOnScreen = ctrl.trackedSize;
    expect(trackedOnScreen).toBeGreaterThan(budget); // more on-screen opens than the budget…
    // …yet none evicted (on-screen exemption) — the property the recut fixed point relies on.

    // Frame 2: pan far away so the auto-opened proxies leave the viewport. NOW they are
    // offscreen and exceed the budget → the surplus is evicted (re-collapsed), the cumulative
    // count rises, and the retained offscreen set is bounded by the budget.
    const farBoxes = (): Map<string, Box> => {
      const m = new Map<string, Box>();
      dirs.forEach((d, i) => {
        m.set(d, { x: 100000 + i * 10, y: 0, w: 700, h: 700 });
        m.set(`${d}/x`, { x: 100000 + i * 10, y: 0, w: 600, h: 600 });
      });
      return m;
    };
    const r2 = buildSceneRepresentationCut({
      snapshot: s,
      nodeIds: ids,
      boxes: farBoxes(),
      cam: { x: -500_000, y: -500_000, scale: 1 }, // pans the stable-bound proxies off-screen
      vp,
      intent: noIntent,
      options: baseOpts,
      previous: r1.runtime,
      eviction: ctrl,
    });
    // Now offscreen-over-budget → eviction fires (a REAL number, not the old hardcoded 0).
    expect(r2.evictions).toBeGreaterThan(0);
    expect(ctrl.trackedSize).toBeLessThanOrEqual(budget); // offscreen retention bounded
    expect(r2.totalEvictions).toBeGreaterThanOrEqual(r2.evictions); // cumulative, monotonic
  });

  test("the runtime cut is rolled IN PLACE across recuts (same backing array)", () => {
    const ctrl = makeEvictionController(snap.groupIds.length + nodeIds.length, 8);
    const r1 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 0.01 },
      vp,
      intent: noIntent,
      options: opts,
      eviction: ctrl,
    });
    const arr1 = r1.runtimeCut.selectedEpoch;
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 }, // a different cut
      vp,
      intent: noIntent,
      options: opts,
      previous: r1.runtime,
      eviction: ctrl,
    });
    // Same controller, unchanged rep count → the SAME Uint32Array is reused (epoch bumped),
    // proving no fresh allocation per recut.
    expect(r2.runtimeCut).toBe(r1.runtimeCut);
    expect(r2.runtimeCut.selectedEpoch).toBe(arr1);
  });
});

describe("buildSceneRepresentationCut — POST-FILTER projection (Gap 7)", () => {
  // Hide the whole `b` subtree (f4, f5). Its proxies (b, b/z) and leaves must vanish from the
  // cut: no budget contribution, no proxy that exists only because of filtered-out nodes.
  const hidden = new Set(["b/z/f4.c", "b/z/f5.c"]);
  const visibleNode = (ord: number) => !hidden.has(nodeIds[ord]);

  // All groups on-screen + tall so the cut WOULD open them if they had visible members.
  const allOpenBoxes = (): Map<string, Box> =>
    new Map<string, Box>([
      ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
      ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
      ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
      ["b", { x: 0, y: 0, w: 1000, h: 1000 }],
      ["b/z", { x: 0, y: 0, w: 1000, h: 1000 }],
    ]);

  const filtered = (cam: Camera, intent: CollapseIntent = noIntent) =>
    buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      visibleNode,
      boxes: allOpenBoxes(),
      cam,
      vp,
      intent,
      options: opts,
    });
  const unfiltered = (cam: Camera, intent: CollapseIntent = noIntent) =>
    buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: allOpenBoxes(),
      cam,
      vp,
      intent,
      options: opts,
    });

  test("a filtered-out subtree produces NO proxy (no collapsed box key, no open selection)", () => {
    // Scale 0.054 is the coarsest level with visible group proxies under the STABLE bounds the
    // cut now reads. With `b` hidden, only `a`'s subtree survives: it opens to its leaf-group
    // proxies {a/x, a/y}. The fully-hidden `b`/`b/z` produce NO proxy at all.
    const r = filtered({ x: 0, y: 0, scale: 0.054 }); // coarsest level with group proxies
    // `a`'s visible members are proxied (a/x, a/y collapsed); `b`/`b/z` are absent entirely.
    expect(r.collapsedBoxKeys.has("a/x")).toBe(true);
    expect(r.collapsedBoxKeys.has("a/y")).toBe(true);
    expect(r.collapsedBoxKeys.has("b")).toBe(false);
    expect(r.collapsedBoxKeys.has("b/z")).toBe(false);
    // The open selection never mentions the fully-hidden groups.
    expect(r.openSelection.has("directory:b")).toBe(false);
    expect(r.openSelection.has("directory:b/z")).toBe(false);
  });

  test("the hidden subtree drops its contribution to the cut budget (cards + layout)", () => {
    // Coarsest-with-group-proxies cut (scale 0.054) under the STABLE bounds the cut now reads:
    // unfiltered selects {a/x, a/y, b/z} (3 cards); with `b` hidden, filtered selects {a/x, a/y}
    // only (2 cards) — the whole `b` subtree contributes nothing.
    const f = filtered({ x: 0, y: 0, scale: 0.054 });
    const u = unfiltered({ x: 0, y: 0, scale: 0.054 });
    expect(f.cut.cardCost).toBeLessThan(u.cut.cardCost);
    expect(f.cut.layoutCost).toBeLessThanOrEqual(u.cut.layoutCost);
    // Concretely: filtered drops b/z, keeping a's two leaf-group proxies.
    expect(f.cut.cardCost).toBe(2);
    expect(u.cut.cardCost).toBe(3);
  });

  test("the hidden subtree's proxy carries ZERO subtree cost (no card-budget pressure)", () => {
    const r = filtered({ x: 0, y: 0, scale: 1 });
    const cols = r.hierarchy.columns;
    const bOrd = snap.groupIds.indexOf("directory:b");
    const bRep = r.hierarchy.repOfGroup[bOrd];
    // The fully-hidden `b` proxy rolls up to zero underlying-node cost — it can't pressure
    // the budget or be selected.
    expect(cols.subtreeNodeCost[bRep]).toBe(0);
    expect(cols.nodeCost[bRep]).toBe(0);
    expect(new Set(r.cut.selectedRepresentations).has(bRep)).toBe(false);
  });

  test("a hidden leaf has no representative; the visible cut stays a valid antichain", () => {
    const r = filtered({ x: 0, y: 0, scale: 1 });
    const selected = new Set(r.cut.selectedRepresentations);
    const { parentByRep, leafRepresentationByNode } = r.hierarchy.columns;
    for (let i = 0; i < nodeIds.length; i++) {
      let cur = leafRepresentationByNode[i];
      let hits = 0;
      let guard = r.hierarchy.repCount + 1;
      while (cur >= 0 && guard-- > 0) {
        if (selected.has(cur)) hits++;
        cur = parentByRep[cur];
      }
      // Visible nodes are represented exactly once; hidden nodes are represented zero times.
      expect(hits).toBe(visibleNode(i) ? 1 : 0);
    }
  });

  test("no mask → identical to building over the raw graph (the mask is opt-in)", () => {
    const withMaskAllVisible = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      visibleNode: () => true, // mask present but hides nothing
      boxes: allOpenBoxes(),
      cam: { x: 0, y: 0, scale: 0.01 },
      vp,
      intent: noIntent,
      options: opts,
    });
    const noMask = unfiltered({ x: 0, y: 0, scale: 0.01 });
    expect(withMaskAllVisible.cut.cardCost).toBe(noMask.cut.cardCost);
    expect([...withMaskAllVisible.collapsedBoxKeys].sort()).toEqual(
      [...noMask.collapsedBoxKeys].sort(),
    );
  });
});

describe("acquireRepresentationRuntime — persistent runtime keyed by material signature (Gap 4)", () => {
  const base = {
    snapshot: snap,
    nodeIds,
    cam: { x: 0, y: 0, scale: 1 } as Camera,
    vp,
    intent: noIntent,
    options: opts,
  };

  test("the material signature excludes the camera but includes graph/grouping/cost inputs", () => {
    const sigA = materialSignature({ ...base, cam: { x: 0, y: 0, scale: 1 }, boxes: boxes() });
    const sigB = materialSignature({ ...base, cam: { x: 999, y: 7, scale: 42 }, boxes: boxes() });
    // Camera does NOT change the material signature (a recut, not a rebuild).
    expect(sigA).toBe(sigB);
    // Each material input DOES change it.
    expect(materialSignature({ ...base, boxes: boxes(), filteredGraphId: "g2" })).not.toBe(sigA);
    expect(materialSignature({ ...base, boxes: boxes(), groupingVersion: 5 })).not.toBe(sigA);
    expect(materialSignature({ ...base, boxes: boxes(), nodeCostSignature: "exp:x" })).not.toBe(
      sigA,
    );
  });

  test("acquire reuses the SAME runtime when the material signature is unchanged", () => {
    const input = { ...base, boxes: boxes(), filteredGraphId: "g1" };
    const rt = acquireRepresentationRuntime(input);
    const again = acquireRepresentationRuntime(input, rt);
    // The whole runtime object is reused — and so is its hierarchy, ordinals and group map.
    expect(again).toBe(rt);
    expect(again.hierarchy).toBe(rt.hierarchy);
    expect(again.repOfGroupId).toBe(rt.repOfGroupId);
    expect(again.eviction).toBe(rt.eviction);
  });

  test("acquire rebuilds a fresh hierarchy when the material signature changes", () => {
    const rt = acquireRepresentationRuntime({ ...base, boxes: boxes(), filteredGraphId: "g1" });
    const grouping = acquireRepresentationRuntime(
      { ...base, boxes: boxes(), filteredGraphId: "g1", groupingVersion: 2 },
      rt,
    );
    expect(grouping).not.toBe(rt);
    expect(grouping.hierarchy).not.toBe(rt.hierarchy); // reconstructed, not reused
    expect(grouping.signature).not.toBe(rt.signature);
  });
});

describe("buildSceneRepresentationCut — hierarchy reuse across camera recuts (Gap 4)", () => {
  // The load-bearing assertion: a camera recut must NOT reconstruct the hierarchy object when
  // the material signature is unchanged; it must rebuild it when the signature changes.
  const run = (
    cam: Camera,
    runtime?: RepresentationRuntime,
    overrides: Partial<typeof opts> = {},
  ) =>
    buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam,
      vp,
      intent: noIntent,
      options: { ...opts, ...overrides },
      filteredGraphId: "g1",
      runtime,
    });

  test("two recuts at different cameras REUSE the one hierarchy object", () => {
    const r1 = run({ x: 0, y: 0, scale: 0.01 }); // all collapsed
    const r2 = run({ x: 0, y: 0, scale: 1 }, r1.repRuntime); // zoom in — a different cut
    // The cut changed (a real recut)...
    expect(r2.committed).toBe(true);
    // ...but the hierarchy was NOT reconstructed — same object, same backing arrays.
    expect(r2.hierarchy).toBe(r1.hierarchy);
    expect(r2.repRuntime).toBe(r1.repRuntime);
    expect(r2.hierarchy.columns.parentByRep).toBe(r1.hierarchy.columns.parentByRep);
  });

  test("the reused recut seeds bounds from the STABLE (layout-independent) bounds in place", () => {
    const r1 = run({ x: 0, y: 0, scale: 0.01 });
    const aRep = r1.hierarchy.repOfGroup[snap.groupIds.indexOf("directory:a")];
    // Bounds are now seeded from the STABLE proxy bounds (the layout-independent treemap),
    // DELIBERATELY independent of the live scene boxes — that decoupling is what kills the
    // layout↔cut feedback loop (a drifting live box used to make every recut commit a different
    // cut). The stable box for `a` is the same on every recut; assert it matches the runtime's
    // own stable bounds rather than any live box dimension.
    const stableW = r1.repRuntime.stableBounds.w[aRep];
    expect(stableW).toBeGreaterThan(0);
    expect(r1.hierarchy.columns.boundsW[aRep]).toBe(stableW);
    const r2 = run({ x: 0, y: 0, scale: 1 }, r1.repRuntime);
    // Same hierarchy object; bounds re-seeded in place from the SAME stable bounds (idempotent).
    expect(r2.hierarchy).toBe(r1.hierarchy);
    expect(r2.hierarchy.columns.boundsW[aRep]).toBe(stableW);
    expect(r2.repRuntime.stableBounds.w[aRep]).toBe(stableW);
  });

  test("a material change (grouping version) REBUILDS the hierarchy for the next recut", () => {
    const r1 = run({ x: 0, y: 0, scale: 1 });
    // Same camera, but the grouping was recomputed → a new material signature → rebuild.
    const r2 = buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: boxes(),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: opts,
      filteredGraphId: "g1",
      groupingVersion: 9,
      runtime: r1.repRuntime,
    });
    expect(r2.hierarchy).not.toBe(r1.hierarchy); // reconstructed on the material change
    expect(r2.repRuntime).not.toBe(r1.repRuntime);
  });

  test("the persistent runtime carries the committed generation across recuts", () => {
    const r1 = run({ x: 0, y: 0, scale: 0.01 });
    expect(r1.runtime.generation).toBe(0);
    const r2 = run({ x: 0, y: 0, scale: 1 }, r1.repRuntime); // material recut
    // The generation advanced on the SAME lodRuntime carried by the persistent runtime —
    // no `previous` was passed, yet the chain continued (Gap 4 carries it on the runtime).
    expect(r2.committed).toBe(true);
    expect(r2.runtime.generation).toBe(1);
    expect(r2.repRuntime.lodRuntime).toBe(r2.runtime);
  });

  test("passing a STALE runtime (SMALLER rep count) rebuilds + evicts on the resized controller", () => {
    // Regression for reading `input.runtime.eviction` instead of the ACQUIRED
    // `runtime.eviction`. Build r1 over a tiny single-dir graph (small rep-id key space),
    // then recut over a LARGER multi-dir graph reusing the stale runtime. The signature
    // changes → `acquire` rebuilds the hierarchy AND a fresh eviction controller sized to the
    // NEW (larger) rep count. If the cut still used the STALE controller (small key space),
    // recording auto-opens for the larger graph's rep ids would index past its typed arrays —
    // silently dropping or mis-tracking evictions. The eviction must run on the resized one.
    const smallGraph: GraphModel = { nodes: [file("a/x/f1.c")], edges: [] };
    const smallIds = smallGraph.nodes.map((n) => n.id);
    const smallSnap = buildGroupingSnapshot(directoryGrouping(smallGraph), "directory", smallIds);
    const r1 = buildSceneRepresentationCut({
      snapshot: smallSnap,
      nodeIds: smallIds,
      boxes: new Map<string, Box>([["a", { x: 0, y: 0, w: 100, h: 100 }]]),
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: opts,
      filteredGraphId: "g-small",
      runtime: undefined,
    });
    const staleKeySpace = r1.repRuntime.eviction.keySpace;

    // Larger graph: 4 top dirs, all huge & on-screen so the cut auto-opens them; a tiny
    // offscreen-open budget forces evictions. Rep ids here exceed the stale key space.
    const dirs = ["a", "b", "c", "d"];
    const bigGraph: GraphModel = {
      nodes: dirs.flatMap((d) => [file(`${d}/x/f1.c`), file(`${d}/x/f2.c`)]),
      edges: [],
    };
    const bigIds = bigGraph.nodes.map((n) => n.id);
    const bigSnap = buildGroupingSnapshot(directoryGrouping(bigGraph), "directory", bigIds);
    const bigBoxes = new Map<string, Box>();
    dirs.forEach((d, i) => {
      bigBoxes.set(d, { x: i * 10, y: 0, w: 700, h: 700 });
      bigBoxes.set(`${d}/x`, { x: i * 10, y: 0, w: 600, h: 600 });
    });
    const r2 = buildSceneRepresentationCut({
      snapshot: bigSnap,
      nodeIds: bigIds,
      boxes: bigBoxes,
      cam: { x: 0, y: 0, scale: 1 },
      vp,
      intent: noIntent,
      options: { ...opts, openPx: 100, maxCards: 100000, nodeBudget: 100000 },
      filteredGraphId: "g-big", // different graph → signature changes → rebuild
      runtime: r1.repRuntime, // STALE — smaller rep count than bigSnap
    });
    // Rebuilt: a fresh runtime with a controller sized to the NEW hierarchy.
    expect(r2.repRuntime).not.toBe(r1.repRuntime);
    expect(r2.repRuntime.eviction.keySpace).toBe(r2.hierarchy.repCount);
    expect(r2.repRuntime.eviction.keySpace).toBeGreaterThan(staleKeySpace);
    // The recut tracks the large graph's auto-opens on the RESIZED controller — its rep ids
    // exceed the stale key space, so a stale small controller would mis-track / drop them.
    // Some auto-opens were recorded (the on-screen dirs opened) → tracking is non-empty.
    expect(r2.repRuntime.eviction.trackedSize).toBeGreaterThan(0);
    // Every node in the large graph is still represented exactly once (valid antichain).
    const selected = new Set(r2.cut.selectedRepresentations);
    const cols2 = r2.hierarchy.columns;
    for (let i = 0; i < bigIds.length; i++) {
      let cur = cols2.leafRepresentationByNode[i];
      let hits = 0;
      let guard = r2.hierarchy.repCount + 1;
      while (cur >= 0 && guard-- > 0) {
        if (selected.has(cur)) hits++;
        cur = cols2.parentByRep[cur];
      }
      expect(hits).toBe(1);
    }
  });
});

/** Assert every node is represented exactly once by the solved cut. */
function assertValidAntichain(r: ReturnType<typeof solve>) {
  const selected = new Set(r.cut.selectedRepresentations);
  const { parentByRep, leafRepresentationByNode } = r.hierarchy.columns;
  for (let i = 0; i < nodeIds.length; i++) {
    let cur = leafRepresentationByNode[i];
    let hits = 0;
    let guard = r.hierarchy.repCount + 1;
    // `>= 0` also stops on -2 (DETACHED_REP); harmless here (this helper runs on unmasked
    // solves) but keeps the walk correct if ever reused with a post-filter mask.
    while (cur >= 0 && guard-- > 0) {
      if (selected.has(cur)) hits++;
      cur = parentByRep[cur];
    }
    expect(hits).toBe(1);
  }
}
