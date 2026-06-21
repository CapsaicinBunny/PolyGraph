// Generic proxy scene materializer (design Gap 1 + P1 "Generic proxy materialization").
//
// WHY this replaces collapseClusters' absorption (collapse.ts:58-68): the old transform
// folds a node into an aggregate ONLY by directory PREFIX or by `communityOf` membership.
// There is no membership path for Package / facet / synthetic-None / render-only
// intermediate / bootstrap-bucket proxies, so the "mode-agnostic" representation cut could
// update LOD state for those modes WITHOUT actually folding their nodes into cards. This
// materializer is GENERIC: it consumes the committed cut's ACTIVE REPRESENTATIVE PER NODE
// (from the rep hierarchy + the selected set) and produces, UNIFORMLY for every mode:
//
//   1. ONE proxy node (aggregate card) per committed PROXY rep (a selected rep that stands
//      in for >1 underlying node — a group rep, an intermediate render-only proxy, a
//      bootstrap bucket, or a leaf rep is rendered as ITS OWN node, never a proxy);
//   2. AGGREGATED edges between committed proxies (boundary edges in the quotient graph) —
//      the full fold scans the supplied edges directly; the persistent edge index (design B2)
//      backs the INCREMENTAL boundary retrieval primitive (Gap 9, materializeChangedBoundary).
//
// The output is a GraphModel (proxy + own nodes, aggregated edges) so it drops into the
// SAME buildView → buildSceneStructure render path collapseClusters fed — no renderer change.
// It works off REP IDENTITY (representativeOf), not box keys or path prefixes, so it never
// pretends every proxy is a collapsed directory.
//
// collapseClusters stays intact for the C1a fallback path (it is the oracle until P5); this
// module is the authoritative P1 path. Pure; deterministic; no React, no GPU.

import { edgesBetween, type RepresentationEdgeIndex } from "./representation-edge-index";
import { NO_GROUP } from "./grouping-snapshot";
import { type RepresentationHierarchy, representativeOf } from "./representation";
import {
  edgeId,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  makeEdge,
  mergeEvidence,
} from "./types";

/** Proxy-node id encoding. Keyed by REP id so it is unique across EVERY proxy kind
 * (group / intermediate / bucket) — not by directory prefix. The `#` keeps it out of the
 * directory-prefix logic in clusters.ts (a proxy is not a real path), so a proxy card draws
 * as a standalone aggregate rather than nesting as a synthetic folder. */
export const PROXY_PREFIX = "«proxy»";
export const PROXY_SUFFIX = "#__proxy__";
export const proxyNodeId = (rep: number): string => `${PROXY_PREFIX}${rep}${PROXY_SUFFIX}`;
export const isProxyId = (id: string): boolean =>
  id.startsWith(PROXY_PREFIX) && id.endsWith(PROXY_SUFFIX);
/** Recover the rep id from a proxy node id (NaN if not a proxy id). */
export const repOfProxyId = (id: string): number =>
  isProxyId(id) ? Number(id.slice(PROXY_PREFIX.length, -PROXY_SUFFIX.length)) : NaN;

/** The committed cut, as the materializer reads it (just the selected rep set). */
export interface MaterializeCut {
  selectedRepresentations: ArrayLike<number>;
}

/**
 * The post-filter edges to aggregate, by node ORDINAL (parallel to the hierarchy's node
 * order). Carries the underlying GraphEdge so its kind + evidence + count survive aggregation
 * (the details panel resolves the relationship from the merged evidence).
 */
export interface ProxyEdgeInput {
  source: number; // node ordinal
  target: number; // node ordinal
  edge: GraphEdge; // the underlying graph edge (kind + evidence + count)
}

export interface MaterializeInput {
  hierarchy: RepresentationHierarchy;
  cut: MaterializeCut;
  /** The original graph (nodes parallel to the hierarchy's node order; edges by id). */
  graph: GraphModel;
  /**
   * Optional: the post-filter visibility mask (node ordinal → visible). A hidden node is
   * neither rendered as itself nor counted into any proxy — it is detached from the scene,
   * exactly as the hierarchy detaches its leaf rep. Omitted → every node is visible.
   */
  visibleNode?: (ordinal: number) => boolean;
  /**
   * Edges by node ordinal (the full-fold edge source). Each carries its underlying GraphEdge so
   * evidence is preserved through aggregation. Omitted → the scene has no edges (a node-only
   * fold). For the INCREMENTAL (Gap 9) path — re-folding only a changed subtree's incident
   * boundaries via the persistent edge index — see {@link materializeChangedBoundary}; the full
   * fold here scans these inputs directly so it correctly places cross-ROOT edges the index
   * cannot pair (its lowest-relevant pair requires a common ancestor).
   */
  edgeInputs?: readonly ProxyEdgeInput[];
}

/**
 * Materialize the committed cut into a proxy scene: a GraphModel whose nodes are the proxy
 * aggregate cards (one per committed proxy rep) plus the raw nodes whose OWN leaf rep is
 * selected, and whose edges are the aggregated boundary edges between the active
 * representatives. Pure — returns a fresh GraphModel.
 *
 * Generic across modes by construction: a node's card-or-self decision is "is this node's
 * active representative a proxy (a rep with children) or its own leaf?" — never "is it under
 * a collapsed directory?". Directory / Community / Package / facet / None all reduce to the
 * same rep walk.
 */
export function materializeProxyScene(input: MaterializeInput): GraphModel {
  const { hierarchy, cut, graph } = input;
  const cols = hierarchy.columns;
  const isVisible = input.visibleNode ?? (() => true);
  const nodeCount = cols.leafRepresentationByNode.length;

  // O(1) membership over the committed cut for the representativeOf walk.
  const selectedMark = new Uint8Array(hierarchy.repCount);
  for (let i = 0; i < cut.selectedRepresentations.length; i++) {
    selectedMark[cut.selectedRepresentations[i]] = 1;
  }
  const isSelected = (rep: number) => selectedMark[rep] === 1;

  // node ordinal → its active representative rep (the deepest selected rep on its chain), or
  // -1 when uncovered (an invalid cut leaves this; a valid one never does). Memoized below.
  const repCache = new Int32Array(nodeCount).fill(-2); // -2 = unresolved, -1 = none
  const repOf = (ordinal: number): number => {
    let r = repCache[ordinal];
    if (r === -2) {
      r = isVisible(ordinal) ? representativeOf(hierarchy, ordinal, isSelected) : -1;
      repCache[ordinal] = r;
    }
    return r;
  };

  // A rep renders as a PROXY card iff it has children (it stands in for >1 underlying node);
  // a selected LEAF rep (no children) renders as the node itself. This is the ONE rule that
  // makes the materializer mode-agnostic — it never inspects the rep's group/box/path.
  const isProxyRep = (rep: number) => cols.firstChildByRep[rep] !== -1;

  // ── 1. Nodes: own nodes whose leaf rep is selected; one aggregate card per committed proxy.
  const nodes: GraphNode[] = [];
  // proxy rep → count of underlying VISIBLE leaves it folds (for the card badge).
  const leafCount = new Map<number, number>();
  // node ordinal → the proxy rep that absorbs it (or -1 = drawn as itself / hidden).
  for (let i = 0; i < nodeCount; i++) {
    if (!isVisible(i)) continue;
    const rep = repOf(i);
    if (rep === -1) continue; // uncovered (invalid cut) — drop, can't place it
    if (isProxyRep(rep)) {
      leafCount.set(rep, (leafCount.get(rep) ?? 0) + 1);
    } else {
      // The node's own leaf rep is selected → render the node verbatim.
      nodes.push(graph.nodes[i]);
    }
  }
  // One aggregate card per committed proxy rep, in ascending rep id (deterministic order).
  const proxyReps = [...leafCount.keys()].sort((a, b) => a - b);
  for (const rep of proxyReps) {
    nodes.push(proxyNodeFor(hierarchy, rep, leafCount.get(rep) ?? 0));
  }

  // ── 2. Edges: aggregate to the active representatives, dropping internal/self edges.
  const byId = new Map<string, GraphEdge>();
  const pushEdge = (sourceId: string, targetId: string, e: GraphEdge): void => {
    if (sourceId === targetId) return; // internal to one proxy — not a scene edge
    const key = edgeId(sourceId, targetId, e.kind);
    const existing = byId.get(key);
    if (existing) {
      mergeEvidence(existing, e);
    } else {
      const merged = makeEdge(sourceId, targetId, e.kind);
      mergeEvidence(merged, e);
      byId.set(key, merged);
    }
  };
  // The scene id an endpoint ordinal maps to: its proxy card id, its own id, or null (hidden /
  // uncovered).
  const sceneIdOf = (ordinal: number): string | null => {
    if (ordinal < 0 || ordinal >= nodeCount) return null;
    const rep = repOf(ordinal);
    if (rep === -1) return null;
    return isProxyRep(rep) ? proxyNodeId(rep) : graph.nodes[ordinal].id;
  };

  // Aggregate every supplied edge onto its endpoints' active representatives. A FULL
  // materialization scans the post-filter edge inputs directly — this is complete and correct
  // for EVERY hierarchy shape, including cross-ROOT edges (two top-level groups in disjoint
  // trees), which the edge index deliberately cannot pair (its lowest-relevant pair requires a
  // common ancestor). The persistent edge index is reserved for the INCREMENTAL (Gap 9) path —
  // a partial re-materialization that retrieves ONLY the boundary edges incident to a changed
  // subtree via the index's ranges, rather than rescanning all edges. The full path below is
  // the authoritative P1 fold; see {@link materializeChangedBoundary} for the index-driven
  // incremental retrieval primitive.
  const edgeInputs = input.edgeInputs ?? [];
  for (const ein of edgeInputs) {
    const s = sceneIdOf(ein.source);
    const t = sceneIdOf(ein.target);
    if (s === null || t === null) continue; // hidden endpoint
    pushEdge(s, t, ein.edge);
  }

  return { nodes, edges: [...byId.values()] };
}

/**
 * Build the aggregate card GraphNode for a committed proxy rep. Generic: a SEMANTIC group
 * proxy borrows its group's label; a render-only proxy (intermediate tier / bootstrap bucket,
 * groupByRep === NO_GROUP) gets a synthetic "N items" label. Either way it is ONE card with a
 * stable proxy id and a member-count badge — exactly what the renderer draws for an aggregate.
 */
function proxyNodeFor(hierarchy: RepresentationHierarchy, rep: number, count: number): GraphNode {
  const cols = hierarchy.columns;
  const g = cols.groupByRep[rep];
  const id = proxyNodeId(rep);
  const groupCount = hierarchy.snapshot.groupIds.length;
  const hasGroup = g !== NO_GROUP && g < groupCount;
  const baseLabel = hasGroup ? hierarchy.snapshot.groupLabels[g] : "group";
  return {
    id,
    kind: "file",
    label: `${baseLabel} · ${count}`,
    // A proxy carries no real path; use its id so directory logic treats it as a leaf card.
    filePath: id,
    line: 0,
    parentFile: id,
  };
}

/**
 * INCREMENTAL boundary retrieval primitive (design B2 / Gap 9). Given two committed SIBLING
 * proxies, retrieve and aggregate ONLY the original edges crossing their boundary — via the
 * persistent edge index's range lookup, WITHOUT rescanning all edges. This is the building
 * block for the future incremental re-materialization (re-fold only a changed subtree's
 * incident boundaries); the full {@link materializeProxyScene} fold scans all edges directly
 * because it must also place cross-ROOT edges the index cannot pair. Returns one aggregated
 * GraphEdge per (kind) crossing the boundary, mapped to the two proxies' scene ids.
 *
 * `edgeInputs` must be aligned 1:1 with the edges the index was built from (same order), so an
 * index `originalEdgeOrdinals` entry indexes straight into it to recover the underlying edge.
 */
export function materializeChangedBoundary(
  hierarchy: RepresentationHierarchy,
  index: RepresentationEdgeIndex,
  edgeInputs: readonly ProxyEdgeInput[],
  repA: number,
  repB: number,
): GraphEdge[] {
  const cols = hierarchy.columns;
  const isProxyRep = (rep: number) => cols.firstChildByRep[rep] !== -1;
  // The (repA, repB) pair is the lowest-relevant tier: one endpoint of each crossing edge is
  // under repA, the other under repB. So an endpoint maps to repA/repB's scene id — the proxy
  // card when that rep is a proxy, else (a selected leaf rep) the underlying node's own id.
  const sceneIdOnSide = (rep: number, fallbackNodeId: string): string =>
    isProxyRep(rep) ? proxyNodeId(rep) : fallbackNodeId;

  const byId = new Map<string, GraphEdge>();
  const ords = edgesBetween(index, repA, repB);
  for (let i = 0; i < ords.length; i++) {
    const ein = edgeInputs[ords[i]];
    if (!ein) continue;
    // Determine which original endpoint sits under repA vs repB via the DFS-interval ancestor
    // test (repA ancestor-or-self of the source's leaf?). The index stored the pair sorted, so
    // either orientation is possible.
    const srcLeaf = cols.leafRepresentationByNode[ein.source];
    const aIsSource =
      cols.entryByRep[repA] <= cols.entryByRep[srcLeaf] &&
      cols.exitByRep[srcLeaf] <= cols.exitByRep[repA];
    const srcRep = aIsSource ? repA : repB;
    const dstRep = aIsSource ? repB : repA;
    const s = sceneIdOnSide(srcRep, ein.edge.source);
    const t = sceneIdOnSide(dstRep, ein.edge.target);
    if (s === t) continue;
    const key = edgeId(s, t, ein.edge.kind);
    const existing = byId.get(key);
    if (existing) mergeEvidence(existing, ein.edge);
    else {
      const merged = makeEdge(s, t, ein.edge.kind);
      mergeEvidence(merged, ein.edge);
      byId.set(key, merged);
    }
  }
  return [...byId.values()];
}

/**
 * Build the ordinal-keyed {@link ProxyEdgeInput}s from a graph (a convenience for callers
 * that have the original GraphModel and a node-id → ordinal map). Drops an edge whose
 * endpoint id is unknown (filtered out of the node ordinal space).
 */
export function buildProxyEdgeInputs(
  graph: GraphModel,
  ordinalOfNode: (id: string) => number | undefined,
): ProxyEdgeInput[] {
  const out: ProxyEdgeInput[] = [];
  for (const e of graph.edges) {
    const s = ordinalOfNode(e.source);
    const t = ordinalOfNode(e.target);
    if (s === undefined || t === undefined) continue;
    out.push({ source: s, target: t, edge: e });
  }
  return out;
}
