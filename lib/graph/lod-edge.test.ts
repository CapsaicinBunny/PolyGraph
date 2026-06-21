import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { buildRepresentationHierarchy, type RepresentationHierarchy } from "./representation";
import { cutFromSelection } from "./lod-cut-solver";
import {
  aggregateLodEdges,
  type EdgeBudget,
  edgeAggregationKey,
  type LodEdgeInput,
  packEdgeKey,
  unpackEdgeKey,
} from "./lod-edge";
import type { GraphModel } from "./types";

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
  edges: [],
};
const nodeIds = graph.nodes.map((n) => n.id);
const ordOfNode = new Map(nodeIds.map((id, i) => [id, i]));
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const h = buildRepresentationHierarchy(snap, nodeIds);

function groupRep(hh: RepresentationHierarchy, id: string): number {
  return hh.repOfGroup[hh.snapshot.groupIds.indexOf(id)];
}
function leafRep(hh: RepresentationHierarchy, nodeId: string): number {
  return hh.columns.leafRepresentationByNode[nodeIds.indexOf(nodeId)];
}

/** Edges as the aggregator consumes them: endpoint node ordinals + kind + counts. */
const edge = (s: string, t: string, kindId = 0, count = 1, exact = count): LodEdgeInput => ({
  source: ordOfNode.get(s)!,
  target: ordOfNode.get(t)!,
  kind: kindId,
  count,
  exactCount: exact,
});

describe("packEdgeKey / unpackEdgeKey — bit-packed bigint (NO hot-path strings)", () => {
  test("the key is (src<<36)|(dst<<8)|kind and round-trips", () => {
    const k = packEdgeKey(5, 9, 3);
    expect(k).toBe((5n << 36n) | (9n << 8n) | 3n);
    expect(unpackEdgeKey(k)).toEqual({ source: 5, target: 9, kind: 3 });
  });

  test("distinct (src,dst,kind) triples yield distinct keys", () => {
    const keys = new Set([
      packEdgeKey(1, 2, 0),
      packEdgeKey(2, 1, 0),
      packEdgeKey(1, 2, 1),
      packEdgeKey(1, 3, 0),
    ]);
    expect(keys.size).toBe(4);
  });

  test("edgeAggregationKey matches the documented bit layout", () => {
    expect(edgeAggregationKey(7, 11, 2)).toBe((7n << 36n) | (11n << 8n) | 2n);
  });
});

describe("aggregateLodEdges — endpoints map to representatives + counts conserve", () => {
  test("at the coarse (root) cut, cross-group edges aggregate onto proxy↔proxy", () => {
    // f1→f4 and f2→f5 both cross a↔b. At the root cut they collapse onto one a→b LodEdge.
    const cut = cutFromSelection(h, h.roots, 0);
    const edges = [edge("a/x/f1.c", "b/z/f4.c", 0, 3), edge("a/x/f2.c", "b/z/f5.c", 0, 2)];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    const a = groupRep(h, "directory:a");
    const b = groupRep(h, "directory:b");
    expect(result.edges.length).toBe(1);
    const le = result.edges[0];
    expect(le.source).toBe(a);
    expect(le.target).toBe(b);
    // Aggregated count conserves the originals (3 + 2 = 5).
    expect(le.count).toBe(5);
    expect(le.exactCount).toBe(5);
  });

  test("aggregation conserves the TOTAL count across all output edges + proxy stats", () => {
    const cut = cutFromSelection(h, h.roots, 0);
    const edges = [
      edge("a/x/f1.c", "b/z/f4.c", 0, 3), // cross a↔b
      edge("a/x/f1.c", "a/x/f2.c", 0, 4), // internal to a (same proxy)
      edge("a/y/f3.c", "b/z/f5.c", 1, 2), // cross a↔b, different kind
    ];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    let total = 0;
    for (const e of result.edges) total += e.count;
    for (const s of result.proxyStats.values()) total += s.count;
    expect(total).toBe(3 + 4 + 2);
  });

  test("two parallel edges of different KIND stay distinct LodEdges", () => {
    const cut = cutFromSelection(h, h.roots, 0);
    const edges = [edge("a/x/f1.c", "b/z/f4.c", 0, 1), edge("a/x/f2.c", "b/z/f5.c", 1, 1)];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    expect(result.edges.length).toBe(2); // kind 0 and kind 1 not merged
  });
});

describe("aggregateLodEdges — same-proxy internal edges become ProxyEdgeStats (not discarded)", () => {
  test("an edge whose endpoints map to the SAME proxy is internal density", () => {
    const cut = cutFromSelection(h, h.roots, 0);
    // f1→f2 are both inside directory:a → internal to proxy a.
    const edges = [edge("a/x/f1.c", "a/x/f2.c", 0, 7)];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    const a = groupRep(h, "directory:a");
    expect(result.edges.length).toBe(0); // not a cross edge
    const stats = result.proxyStats.get(a);
    expect(stats).toBeDefined();
    expect(stats!.count).toBe(7); // density retained, not discarded
    expect(stats!.edgeCount).toBe(1);
  });

  test("when the cut is fully refined, the same edge is a real leaf↔leaf edge", () => {
    // Open everything to leaves: f1 and f2 are now distinct reps → a cross edge.
    const leaves = nodeIds.map((id) => leafRep(h, id));
    const cut = cutFromSelection(h, leaves, 0);
    const edges = [edge("a/x/f1.c", "a/x/f2.c", 0, 7)];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    expect(result.edges.length).toBe(1);
    expect(result.proxyStats.size).toBe(0);
    expect(result.edges[0].source).toBe(leafRep(h, "a/x/f1.c"));
    expect(result.edges[0].target).toBe(leafRep(h, "a/x/f2.c"));
  });
});

describe("aggregateLodEdges — exact vs inferred split", () => {
  test("exactCount + inferredCount partition the aggregated count", () => {
    const cut = cutFromSelection(h, h.roots, 0);
    // count 5 of which 3 exact → 2 inferred.
    const edges = [edge("a/x/f1.c", "b/z/f4.c", 0, 5, 3)];
    const result = aggregateLodEdges(h, cut, edges, ordOfNode.size);
    const le = result.edges[0];
    expect(le.exactCount).toBe(3);
    expect(le.inferredCount).toBe(2);
    expect(le.exactCount + le.inferredCount).toBe(le.count);
  });
});

describe("edge degradation ladder — independent edge budget", () => {
  const cut = cutFromSelection(h, h.roots, 0);
  const manyEdges: LodEdgeInput[] = [
    edge("a/x/f1.c", "b/z/f4.c", 0, 1),
    edge("a/x/f2.c", "b/z/f5.c", 1, 1),
    edge("a/y/f3.c", "b/z/f4.c", 2, 1),
  ];

  test("under a generous edge budget, stage 0 keeps all aggregated edges", () => {
    const budget: EdgeBudget = { targetEdges: 100, hardEdges: 100 };
    const result = aggregateLodEdges(h, cut, manyEdges, ordOfNode.size, budget);
    expect(result.stage).toBe(0);
    expect(result.edges.length).toBe(3);
  });

  test("a tight edge budget climbs the ladder and never exceeds hardEdges", () => {
    const budget: EdgeBudget = { targetEdges: 1, hardEdges: 2 };
    const result = aggregateLodEdges(h, cut, manyEdges, ordOfNode.size, budget);
    expect(result.stage).toBeGreaterThan(0); // degraded
    expect(result.edges.length).toBeLessThanOrEqual(budget.hardEdges);
  });
});
