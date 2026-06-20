// Graph-shape features for the Smart planner: cheap, deterministic descriptors that
// say what KIND of graph a (sub)graph is, so the planner can pick the engine that
// fits. All O(n+m)-ish and reuse the existing SCC / community / tree primitives.

import { detectCommunities } from "./community";
import { stronglyConnectedComponents } from "./scc";
import { treeScore } from "./tree";

interface Edge {
  source: string;
  target: string;
}

export interface GraphShape {
  nodeCount: number;
  edgeCount: number;
  /** m / (n·(n-1)) — directed density in [0,1]. */
  density: number;
  componentCount: number;
  /** Fraction of nodes with no edges. */
  isolateRatio: number;
  /** Fraction of nodes with total degree exactly 1. */
  leafRatio: number;
  /** Fraction of nodes that are pure sources (in-degree 0, out-degree > 0). */
  sourceRatio: number;
  /** Fraction of nodes that are pure sinks (out-degree 0, in-degree > 0). */
  sinkRatio: number;
  /** Fraction of nodes inside a strongly-connected component of size > 1. */
  sccNodeRatio: number;
  /** 1 - sccNodeRatio: how DAG-like (1 = acyclic). */
  dagScore: number;
  /** How tree-like, in [0,1] (see tree.ts). */
  treeScore: number;
  /** Gini coefficient of the degree distribution (0 = uniform, →1 = hub-dominated). */
  degreeGini: number;
  /** Fraction of nodes whose degree exceeds mean + 1.5·stddev (hubs). */
  hubRatio: number;
  /** Number of detected communities. */
  communityCount: number;
  /** Modularity of the detected community partition (0 = none, →~1 = strong structure). */
  modularity: number;
  /** Size of the largest community / n. */
  largestCommunityRatio: number;
}

// Gini coefficient via the sorted formula — O(n log n), not the O(n²) pairwise sum.
// This runs inside the Smart planner's per-cluster shape analysis, which must stay
// near-linear, so the double loop was a real hazard on large clusters. Equivalent to
// (Σᵢ Σⱼ |xᵢ − xⱼ|) / (2n²·mean).
function giniOf(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let total = 0;
  for (const v of sorted) total += v;
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function graphShape(nodeIds: string[], edges: Edge[]): GraphShape {
  const n = nodeIds.length;
  const ids = new Set(nodeIds);
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const undirected = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    inDeg.set(id, 0);
    outDeg.set(id, 0);
    undirected.set(id, new Set());
  }
  let m = 0;
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    m += 1;
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    undirected.get(e.source)!.add(e.target);
    undirected.get(e.target)!.add(e.source);
  }
  if (n === 0) {
    return {
      nodeCount: 0,
      edgeCount: 0,
      density: 0,
      componentCount: 0,
      isolateRatio: 0,
      leafRatio: 0,
      sourceRatio: 0,
      sinkRatio: 0,
      sccNodeRatio: 0,
      dagScore: 1,
      treeScore: 1,
      degreeGini: 0,
      hubRatio: 0,
      communityCount: 0,
      modularity: 0,
      largestCommunityRatio: 0,
    };
  }

  // Connected components (undirected) + per-node total degree.
  const visited = new Set<string>();
  let componentCount = 0;
  for (const seed of [...nodeIds].sort()) {
    if (visited.has(seed)) continue;
    componentCount += 1;
    const queue = [seed];
    visited.add(seed);
    for (let i = 0; i < queue.length; i++) {
      for (const nb of undirected.get(queue[i]) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
  }

  let isolates = 0;
  let leaves = 0;
  let sources = 0;
  let sinks = 0;
  const degrees: number[] = [];
  for (const id of nodeIds) {
    const i = inDeg.get(id) ?? 0;
    const o = outDeg.get(id) ?? 0;
    const deg = (undirected.get(id) ?? new Set()).size;
    degrees.push(deg);
    if (i === 0 && o === 0) isolates += 1;
    if (i + o === 1) leaves += 1;
    if (i === 0 && o > 0) sources += 1;
    if (o === 0 && i > 0) sinks += 1;
  }

  const degreeSum = degrees.reduce((a, b) => a + b, 0);
  const mean = degreeSum / n;
  const variance = degrees.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const hubThreshold = mean + 1.5 * std;
  const hubs = degrees.filter((d) => d > hubThreshold).length;

  const sccs = stronglyConnectedComponents(
    nodeIds,
    edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  );
  let sccNodes = 0;
  for (const c of sccs) if (c.members.length > 1) sccNodes += c.members.length;
  const sccNodeRatio = sccNodes / n;

  // Communities + modularity Q + largest-community share (from the undirected view used
  // for detection). Modularity tells the planner whether community structure is REAL —
  // a stronger Force signal than a raw community count (almost any graph has >1 community).
  const community = detectCommunities(nodeIds, edges);
  const communityIds = new Set(community.values());
  const sumDeg = new Map<string, number>();
  const sizeOf = new Map<string, number>();
  const intraEndpoints = new Map<string, number>();
  nodeIds.forEach((id, i) => {
    const c = community.get(id) ?? id;
    sumDeg.set(c, (sumDeg.get(c) ?? 0) + degrees[i]);
    sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
    let same = 0;
    for (const nb of undirected.get(id) ?? []) if ((community.get(nb) ?? nb) === c) same += 1;
    intraEndpoints.set(c, (intraEndpoints.get(c) ?? 0) + same);
  });
  const mUndir = degreeSum / 2;
  let modularity = 0;
  if (mUndir > 0) {
    for (const c of communityIds) {
      const lc = (intraEndpoints.get(c) ?? 0) / 2; // intra-community edges (endpoints counted twice)
      const dc = sumDeg.get(c) ?? 0;
      modularity += lc / mUndir - (dc / (2 * mUndir)) ** 2;
    }
  }
  let largestCommunity = 0;
  for (const s of sizeOf.values()) if (s > largestCommunity) largestCommunity = s;

  return {
    nodeCount: n,
    edgeCount: m,
    density: n > 1 ? m / (n * (n - 1)) : 0,
    componentCount,
    isolateRatio: isolates / n,
    leafRatio: leaves / n,
    sourceRatio: sources / n,
    sinkRatio: sinks / n,
    sccNodeRatio,
    dagScore: 1 - sccNodeRatio,
    treeScore: treeScore(nodeIds, edges),
    degreeGini: giniOf(degrees),
    hubRatio: hubs / n,
    communityCount: communityIds.size,
    modularity,
    largestCommunityRatio: largestCommunity / n,
  };
}
