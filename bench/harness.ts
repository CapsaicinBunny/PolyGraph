// Shared graph/layout helpers for the benchmark + snapshot suites. Drives the same
// pipeline the app uses: analyzeProject → buildSceneStructure → layout.

import { analyzeProject } from "../lib/kernel";
import { buildSceneStructure, type SceneFilters } from "../lib/graph/scene";
import { layoutInWorker } from "../lib/layout-client";
import { availableFolders, availableLanguages } from "../lib/graph/filters";
import { FILTERABLE_EDGE_KINDS } from "../lib/graph/visual";
import type { FacetKey } from "../lib/graph/dimensions";
import type { FacetSelection } from "../lib/graph/facet-selection";
import { buildAdjacency } from "../lib/graph/query";
import { stronglyConnectedComponents } from "../lib/layout/scc";
import type { AnalyzeResult, GraphModel } from "../lib/graph/types";
import type { LayoutAlgorithm } from "../lib/layout";
import type { LoadedFixture } from "./fixtures";
import { hashString } from "./metrics";

export function analyze(fx: LoadedFixture): Promise<AnalyzeResult> {
  return analyzeProject(fx.files, { packages: fx.packages });
}

/** All facets enabled, folders/languages derived from the graph (mirrors the app's reset). */
export function defaultFilters(graph: GraphModel): SceneFilters {
  return {
    showExternal: false,
    // Empty map ⇒ every facet value enabled (kind/category/env/runtime/role).
    enabledFacets: new Map<FacetKey, FacetSelection>(),
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    enabledFolders: new Set(availableFolders(graph).map((f) => f.name)),
    enabledLanguages: new Set(availableLanguages(graph).map((l) => l.key)),
  };
}

/** Build the scene + run a layout algorithm; returns node positions (file-level view). */
export async function layoutGraph(
  graph: GraphModel,
  algorithm: LayoutAlgorithm,
): Promise<Map<string, { x: number; y: number }>> {
  const scene = buildSceneStructure(graph, new Set(), defaultFilters(graph), algorithm, "LR");
  const { positions } = await layoutInWorker(scene.layoutInput, scene.options);
  return positions;
}

export interface GraphSummary {
  totalNodes: number;
  totalEdges: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  /** Sorted member-id lists of every cycle (SCC of size > 1). */
  cycles: string[][];
  /** Top fan-in nodes: [id, inDegree], highest first. */
  topHubs: [string, number][];
  /** Content hash over the sorted node + edge identity sets (drift detector). */
  hash: string;
}

/**
 * A deterministic, reviewable structural snapshot of a graph — counts, cycles, hubs,
 * and a content hash. Stable across runs for the same input, so it works as a golden.
 */
export function summarize(graph: GraphModel): GraphSummary {
  const nodesByKind: Record<string, number> = {};
  const edgesByKind: Record<string, number> = {};
  for (const n of graph.nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
  for (const e of graph.edges) edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1;

  const ids = graph.nodes.map((n) => n.id);
  const sccs = stronglyConnectedComponents(ids, graph.edges);
  const cycles = sccs
    .filter((c) => c.members.length > 1)
    .map((c) => [...c.members].sort())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const inDeg = new Map<string, number>();
  const adj = buildAdjacency(graph);
  for (const id of ids) inDeg.set(id, (adj.inc.get(id) ?? []).length);
  const topHubs = [...inDeg.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);

  const nodeKey = graph.nodes
    .map((n) => `${n.id}\t${n.kind}`)
    .sort()
    .join("\n");
  const edgeKey = graph.edges
    .map((e) => `${e.source}->${e.target}:${e.kind}`)
    .sort()
    .join("\n");

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    nodesByKind,
    edgesByKind,
    cycles,
    topHubs,
    hash: hashString(`${nodeKey}\n--\n${edgeKey}`),
  };
}
