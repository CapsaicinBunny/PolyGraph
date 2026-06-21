// Gap 2 / P2 "none-flat-render": None has NO visible containers — its synthetic
// components→communities groups are CUT PROXIES, not visible cards. So an over-budget None graph
// must fold its low-importance leaves into RENDER-ONLY OVERFLOW proxies (the bootstrap super-root /
// root buckets / intermediate tiers, all `groupByRep === NO_GROUP`) and materialize them FLAT — a
// `+N` overflow card with NO named group container box. This test runs the EXISTING synthetic-None
// hierarchy through the real representation cut, then through the GENERIC proxy materializer, and
// proves the materialized None scene is (a) flat (+N overflow cards, never a named group card),
// (b) free of any container/group box, and (c) bounded by the card budget.

import { describe, expect, test } from "bun:test";
import { syntheticNoneGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import {
  buildSceneRepresentationCut,
  DEFAULT_REP_LOD_OPTIONS,
  type RepLodResult,
} from "./lod-representation-cut";
import {
  isOverflowProxyRep,
  isProxyId,
  materializeProxyScene,
  OVERFLOW_LABEL,
  repOfProxyId,
} from "./proxy-materialize";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel } from "./types";

const file = (id: string) => ({
  id,
  kind: "file" as const,
  label: id,
  filePath: id,
  line: 0,
  parentFile: id,
});

const vp: Viewport = { w: 800, h: 600 };
const noIntent: CollapseIntent = new Map();
const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };
// None emits NO cluster boxes at all — the whole point of the stable-bounds path.
const noBoxes = (): Map<string, Box> => new Map<string, Box>();

describe("None renders FLAT — over-budget low-importance nodes fold into +N overflow proxies", () => {
  // The canonical hostile None shape: MANY isolated files. Each is its own connected component →
  // its own synthetic community → its own natural root. Un-normalized the coarsest cut would be
  // one card PER component (N cards), starting OVER budget. The bootstrap super-root / bucket tier
  // (P0.5) folds them into a bounded handful of RENDER-ONLY overflow proxies instead.
  const N = 600;
  const graph: GraphModel = {
    nodes: Array.from({ length: N }, (_, i) => file(`iso${i}`)),
    edges: [],
  };
  const nodeIds = graph.nodes.map((n) => n.id);
  const snap = buildGroupingSnapshot(syntheticNoneGrouping(graph), "none", nodeIds);

  function solve(cam: Camera): RepLodResult {
    return buildSceneRepresentationCut({
      snapshot: snap,
      nodeIds,
      boxes: noBoxes(),
      cam,
      vp,
      intent: noIntent,
      options: opts,
    });
  }

  test("the coarsest None cut materializes FLAT +N overflow cards, no named group cards", () => {
    const r = solve({ x: 0, y: 0, scale: 0.0001 }); // fully zoomed out → over-budget bootstrap
    const scene = materializeProxyScene({
      hierarchy: r.hierarchy,
      cut: r.cut,
      graph,
      // no edgeInputs — None here is edge-free; this isolates the NODE fold (the +N cards).
    });

    const proxies = scene.nodes.filter((n) => isProxyId(n.id));
    // The bootstrap folded the N components into a bounded handful of proxies, not N cards.
    expect(proxies.length).toBeGreaterThan(0);
    expect(proxies.length).toBeLessThan(N);

    // EVERY committed proxy is a render-only OVERFLOW proxy (None has no semantic containers), so
    // EVERY proxy card is a flat `+N` overflow badge — never a named-group card (`label · count`).
    for (const p of proxies) {
      const rep = repOfProxyId(p.id);
      expect(isOverflowProxyRep(r.hierarchy, rep)).toBe(true);
      expect(p.label.startsWith("+")).toBe(true);
      expect(p.label).not.toContain(" · ");
    }
  });

  test("every overflow card's +N badge equals its folded leaf count (the fold is honest)", () => {
    const r = solve({ x: 0, y: 0, scale: 0.0001 });
    const scene = materializeProxyScene({ hierarchy: r.hierarchy, cut: r.cut, graph });

    const proxies = scene.nodes.filter((n) => isProxyId(n.id));
    // Recompute each proxy's folded VISIBLE-leaf count from the hierarchy and assert the badge.
    const cols = r.hierarchy.columns;
    const selected = new Set(r.cut.selectedRepresentations);
    const leafCountUnder = (root: number): number => {
      let c = 0;
      const stack = [root];
      while (stack.length) {
        const rep = stack.pop()!;
        if (cols.firstChildByRep[rep] === -1) c++;
        else
          for (let k = cols.firstChildByRep[rep]; k !== -1; k = cols.nextSiblingByRep[k])
            stack.push(k);
      }
      return c;
    };
    let foldedTotal = 0;
    for (const p of proxies) {
      const rep = repOfProxyId(p.id);
      const count = leafCountUnder(rep);
      foldedTotal += count;
      expect(p.label).toBe(OVERFLOW_LABEL(count));
      expect(selected.has(rep)).toBe(true);
    }
    // All N leaves are accounted for by the overflow fold (every node represented once, flat).
    expect(foldedTotal).toBe(N);
  });

  test("a flat scene: no raw file leaks at the coarsest cut, and the card count stays bounded", () => {
    const r = solve({ x: 0, y: 0, scale: 0.0001 });
    const scene = materializeProxyScene({ hierarchy: r.hierarchy, cut: r.cut, graph });

    // Zoomed fully out, no raw file survives — every leaf is absorbed by an overflow proxy.
    const rawFiles = scene.nodes.filter((n) => !isProxyId(n.id));
    expect(rawFiles.length).toBe(0);

    // BOUNDED: the materialized card count is the cut's card cost, well within the hard budget —
    // never the N un-normalized roots.
    expect(scene.nodes.length).toBeLessThanOrEqual(opts.nodeBudget);
    expect(scene.nodes.length).toBe(r.cut.cardCost);
    expect(scene.nodes.length).toBeLessThan(N);
  });

  test("zoom-in refines the overflow proxies into more, still-flat +N cards (None stays flat)", () => {
    const coarse = solve({ x: 0, y: 0, scale: 0.0001 });
    const fine = solve({ x: 0, y: 0, scale: 1 });
    const coarseScene = materializeProxyScene({
      hierarchy: coarse.hierarchy,
      cut: coarse.cut,
      graph,
    });
    const fineScene = materializeProxyScene({ hierarchy: fine.hierarchy, cut: fine.cut, graph });

    // Refinement ADDS cards (the cut opened deeper) — the central None-progressive-refine promise.
    const coarseProxies = coarseScene.nodes.filter((n) => isProxyId(n.id)).length;
    expect(fineScene.nodes.length).toBeGreaterThan(coarseScene.nodes.length);

    // Whatever proxies remain after refining are STILL flat overflow cards — None never grows a
    // named container at any zoom (its groups are cut proxies, not visible cards).
    for (const p of fineScene.nodes) {
      if (!isProxyId(p.id)) continue;
      expect(isOverflowProxyRep(fine.hierarchy, repOfProxyId(p.id))).toBe(true);
      expect(p.label.startsWith("+")).toBe(true);
    }
    expect(coarseProxies).toBeGreaterThan(0);
  });
});
