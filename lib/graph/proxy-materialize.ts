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

// ─────────────────────────────────────────────────────────────────────────────
// Incremental materialization (design impl point 4 / Gap 9 / B3).
//
// WHY: {@link materializeProxyScene} is a FULL fold — O(all visible nodes + all edge inputs)
// per call. A camera recut that opens or closes ONE group should NOT pay that: it changes a
// bounded region of the rep tree, so the scene mutation is bounded too. This section adds the
// CutDiff-driven incremental path the spec requires:
//
//   - {@link diffCuts} computes the changed subtree roots between two committed cuts.
//   - {@link IncrementalMaterializer} holds the prior scene + persistent per-ordinal indices
//     (built ONCE, reused every recut) and, given a {@link CutDiff}, re-folds ONLY the nodes
//     in changed subtrees and ONLY the boundary edges incident to those nodes — reusing every
//     `unchanged` card / aggregated edge byte-identically.
//
// Cost is proportional to the CHANGED REGION (Σ leaves under refined ∪ coarsened roots + the
// original edges incident to them), never O(all nodes + all edges). The {@link MaterializeCounter}
// hook makes that bound observable for the merge-gate test (assert touched work ≤ changed region).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The diff between two committed cuts, expressed as the changed SUBTREE ROOTS (design Gap 9 /
 * P3 cut diff). A rep appears in exactly one bucket:
 *
 *  - `refined`:   selected in the PREVIOUS cut, NOT in the next — a proxy that OPENED (its
 *                 subtree is now represented by deeper reps). Its underlying nodes move from
 *                 this proxy to their new (finer) representatives.
 *  - `coarsened`: selected in the NEXT cut, NOT in the previous — a proxy that FOLDED (it now
 *                 stands in for descendants that were previously open). Its underlying nodes
 *                 move from their old (finer) reps to this proxy.
 *  - `unchanged`: selected in BOTH cuts — its card, members, and incident-but-internal edges
 *                 are reused byte-identical (never re-folded).
 *
 * The changed region the incremental materializer touches is the union of the subtrees rooted
 * at `refined ∪ coarsened`; `unchanged` roots are never visited.
 */
export interface CutDiff {
  refined: Uint32Array;
  coarsened: Uint32Array;
  unchanged: Uint32Array;
}

/**
 * Compute the {@link CutDiff} between a previous and next selected-rep set. O(prev + next) over
 * the two selections — independent of the node/edge counts. `prevSelected`/`nextSelected` are the
 * `selectedRepresentations` of the two committed cuts (rep ids). `repCount` sizes the membership
 * scratch.
 */
export function diffCuts(
  prevSelected: ArrayLike<number>,
  nextSelected: ArrayLike<number>,
  repCount: number,
): CutDiff {
  const inPrev = new Uint8Array(repCount);
  const inNext = new Uint8Array(repCount);
  for (let i = 0; i < prevSelected.length; i++) inPrev[prevSelected[i]] = 1;
  for (let i = 0; i < nextSelected.length; i++) inNext[nextSelected[i]] = 1;
  const refined: number[] = [];
  const coarsened: number[] = [];
  const unchanged: number[] = [];
  for (let i = 0; i < prevSelected.length; i++) {
    const r = prevSelected[i];
    if (inNext[r] === 1) unchanged.push(r);
    else refined.push(r); // was selected, no longer → opened
  }
  for (let i = 0; i < nextSelected.length; i++) {
    const r = nextSelected[i];
    if (inPrev[r] === 0) coarsened.push(r); // newly selected → folded
  }
  return {
    refined: Uint32Array.from(refined),
    coarsened: Uint32Array.from(coarsened),
    unchanged: Uint32Array.from(unchanged),
  };
}

/**
 * Instrumentation hook (the merge-gate counter). The incremental materializer increments these
 * for every original node / edge it TOUCHES, so a test can assert the work is bounded by the
 * changed subtree size and that a single-group refinement does NOT scan all original nodes/edges.
 * Optional — omitted on the production path (the counts cost a branch, nothing more).
 */
export interface MaterializeCounter {
  /** A node ordinal whose active representative was (re)resolved this recut. */
  nodesScanned: number;
  /** An original edge input whose aggregation was (re)evaluated this recut. */
  edgesScanned: number;
}

/**
 * A persistent, CutDiff-driven materializer (design impl point 4 / Gap 9). Built ONCE per
 * material signature (alongside the persistent RepresentationRuntime — Gap 4), then driven each
 * committed recut by {@link applyDiff}, which mutates ONLY the changed region and returns a fresh
 * GraphModel sharing every unchanged card / edge with the prior scene.
 *
 * Persistent state (all O(nodes + edges) to build ONCE, never per recut):
 *  - `nodeByDfs` / `dfsOfLeaf`: node ordinals sorted by their leaf rep's DFS entry, so the nodes
 *    under any subtree root are a CONTIGUOUS range `[entry, exit)` found by binary search — node
 *    enumeration is O(log N + changed-nodes), never O(N).
 *  - `edgesByOrdinal` (CSR): the edge-input indices incident to each node ordinal, so the edges
 *    that must be re-aggregated when a node's representative changes are retrieved WITHOUT
 *    scanning all edges.
 *  - `sceneIdByNode`: the current active scene id of every node (its proxy card id or own id, or
 *    null when hidden/uncovered) — the basis for byte-identical reuse: an edge whose endpoints'
 *    scene ids are both unchanged keeps its prior aggregated edge.
 *  - `aggEdges`: the current aggregated scene edges keyed by `edgeId`, carried across recuts.
 *  - per-proxy `leafCount` and `internalEdges` (the internal density stat the error scoring reads).
 */
export class IncrementalMaterializer {
  private readonly hierarchy: RepresentationHierarchy;
  private readonly graph: GraphModel;
  private readonly edgeInputs: readonly ProxyEdgeInput[];
  private readonly isVisible: (ordinal: number) => boolean;
  private readonly nodeCount: number;

  // node ordinals sorted by their leaf rep's DFS entry; `dfsStartOfNode[i]` is the sorted index.
  private readonly nodeByDfs: Uint32Array;
  private readonly entryOfNode: Uint32Array; // entryByRep of each node's leaf rep (sorted-aligned)
  // edge incidence by node ordinal (CSR): which edge inputs touch each node.
  private readonly incOffsets: Uint32Array;
  private readonly incEntries: Uint32Array;

  // mutable scene state, carried across recuts.
  private sceneIdByNode: (string | null)[];
  private leafCount = new Map<number, number>(); // proxy rep → folded visible-leaf count
  private internalEdges = new Map<number, number>(); // proxy rep → internal (absorbed) edge count
  private aggEdges = new Map<string, GraphEdge>(); // current aggregated scene edges
  // The contributing edge-input ordinals behind each aggregate key / each proxy's internal count.
  // Carried across recuts so a dirtied key/proxy can be recomputed EXACTLY from its members
  // (additive evidence merge is not reversible), bounded by that boundary, not the full edge set.
  private membersByKey = new Map<string, Set<number>>();
  private internalMembers = new Map<number, Set<number>>();
  private committed = false; // has a full baseline been materialized yet?
  private selectedMark: Uint8Array;

  constructor(input: MaterializeInput) {
    this.hierarchy = input.hierarchy;
    this.graph = input.graph;
    this.edgeInputs = input.edgeInputs ?? [];
    this.isVisible = input.visibleNode ?? (() => true);
    this.nodeCount = this.hierarchy.columns.leafRepresentationByNode.length;
    this.sceneIdByNode = new Array(this.nodeCount).fill(null);
    this.selectedMark = new Uint8Array(this.hierarchy.repCount);

    const cols = this.hierarchy.columns;
    // 1. node DFS-order index — nodes sorted by their leaf rep's DFS entry. The subtree under
    //    any rep R is the contiguous run of nodes whose entry ∈ [entryByRep[R], exitByRep[R]).
    const order = new Uint32Array(this.nodeCount);
    for (let i = 0; i < this.nodeCount; i++) order[i] = i;
    const entryOfLeaf = (ord: number) => cols.entryByRep[cols.leafRepresentationByNode[ord]];
    const sorted = Array.from(order).sort((a, b) => entryOfLeaf(a) - entryOfLeaf(b));
    this.nodeByDfs = Uint32Array.from(sorted);
    this.entryOfNode = new Uint32Array(this.nodeCount);
    for (let i = 0; i < this.nodeCount; i++) this.entryOfNode[i] = entryOfLeaf(this.nodeByDfs[i]);

    // 2. edge incidence by node ordinal (CSR) — each edge input registered under BOTH endpoints.
    this.incOffsets = new Uint32Array(this.nodeCount + 1);
    for (const ein of this.edgeInputs) {
      if (ein.source >= 0 && ein.source < this.nodeCount) this.incOffsets[ein.source + 1]++;
      if (ein.target >= 0 && ein.target < this.nodeCount) this.incOffsets[ein.target + 1]++;
    }
    for (let i = 0; i < this.nodeCount; i++) this.incOffsets[i + 1] += this.incOffsets[i];
    this.incEntries = new Uint32Array(this.incOffsets[this.nodeCount]);
    {
      const cursor = this.incOffsets.slice(0, this.nodeCount);
      for (let e = 0; e < this.edgeInputs.length; e++) {
        const ein = this.edgeInputs[e];
        if (ein.source >= 0 && ein.source < this.nodeCount)
          this.incEntries[cursor[ein.source]++] = e;
        if (ein.target >= 0 && ein.target < this.nodeCount)
          this.incEntries[cursor[ein.target]++] = e;
      }
    }
  }

  /** Internal-edge density stat for a committed proxy rep (edges fully absorbed inside it). */
  internalEdgeCount(rep: number): number {
    return this.internalEdges.get(rep) ?? 0;
  }

  /** Folded visible-leaf count of a committed proxy rep. */
  proxyLeafCount(rep: number): number {
    return this.leafCount.get(rep) ?? 0;
  }

  private isProxyRep(rep: number): boolean {
    return this.hierarchy.columns.firstChildByRep[rep] !== -1;
  }

  /** The node ordinals under a subtree root, as a [lo, hi) range into {@link nodeByDfs}. */
  private subtreeRange(rep: number): { lo: number; hi: number } {
    const cols = this.hierarchy.columns;
    const entry = cols.entryByRep[rep];
    const exit = cols.exitByRep[rep];
    // first index with entryOfNode ≥ entry, and first with entryOfNode ≥ exit.
    const lower = (target: number): number => {
      let lo = 0;
      let hi = this.nodeCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.entryOfNode[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return { lo: lower(entry), hi: lower(exit) };
  }

  /** Resolve a node ordinal's active scene id under the current selection mark. */
  private resolveSceneId(ordinal: number): string | null {
    if (!this.isVisible(ordinal)) return null;
    const rep = representativeOf(this.hierarchy, ordinal, (r) => this.selectedMark[r] === 1);
    if (rep === -1) return null;
    return this.isProxyRep(rep) ? proxyNodeId(rep) : this.graph.nodes[ordinal].id;
  }

  /**
   * The FULL baseline fold — run once (no prior scene) or to reset. Establishes
   * {@link sceneIdByNode}, the per-proxy stats and {@link aggEdges} from the selection. Counts
   * every visible node + every edge input (this IS the O(N) path; later recuts avoid it via
   * {@link applyDiff}). Returns the materialized GraphModel.
   */
  materializeFull(cut: MaterializeCut, counter?: MaterializeCounter): GraphModel {
    this.selectedMark.fill(0);
    for (let i = 0; i < cut.selectedRepresentations.length; i++) {
      this.selectedMark[cut.selectedRepresentations[i]] = 1;
    }
    this.leafCount = new Map();
    this.internalEdges = new Map();
    this.aggEdges = new Map();
    this.membersByKey = new Map();
    this.internalMembers = new Map();
    this.sceneIdByNode = new Array(this.nodeCount).fill(null);

    for (let i = 0; i < this.nodeCount; i++) {
      if (counter) counter.nodesScanned++;
      const sid = this.resolveSceneId(i);
      this.sceneIdByNode[i] = sid;
      if (sid === null) continue;
      const rep = representativeOf(this.hierarchy, i, (r) => this.selectedMark[r] === 1);
      if (this.isProxyRep(rep)) this.leafCount.set(rep, (this.leafCount.get(rep) ?? 0) + 1);
    }
    // Record each edge's membership, then materialize every aggregate key / internal count once.
    for (let e = 0; e < this.edgeInputs.length; e++) {
      if (counter) counter.edgesScanned++;
      this.recordEdgeMembership(e);
    }
    for (const key of this.membersByKey.keys()) this.recomputeKey(key);
    for (const rep of this.internalMembers.keys()) this.recomputeInternal(rep);
    this.committed = true;
    return this.snapshotScene();
  }

  /**
   * Record ONE edge input's membership under its endpoints' CURRENT scene ids — into either a
   * proxy-pair aggregate key ({@link membersByKey}) or, when internal to one proxy, that proxy's
   * internal-density member set ({@link internalMembers}). Membership is the basis for an EXACT,
   * bounded rebuild (additive evidence merge is not reversible, so a dirtied aggregate is recomputed
   * from its members, never decremented).
   */
  private recordEdgeMembership(e: number): void {
    const ein = this.edgeInputs[e];
    const s = this.sceneIdByNode[ein.source];
    const t = this.sceneIdByNode[ein.target];
    if (s === null || t === null) return; // hidden endpoint
    if (s === t) {
      const rep = repOfProxyId(s);
      if (Number.isNaN(rep)) return;
      let set = this.internalMembers.get(rep);
      if (!set) this.internalMembers.set(rep, (set = new Set()));
      set.add(e);
      return;
    }
    const key = edgeId(s, t, ein.edge.kind);
    let set = this.membersByKey.get(key);
    if (!set) this.membersByKey.set(key, (set = new Set()));
    set.add(e);
  }

  /** (Re)build the aggregate scene edge for one key from its full member set (exact, bounded). */
  private recomputeKey(key: string): void {
    const members = this.membersByKey.get(key);
    if (!members || members.size === 0) {
      this.membersByKey.delete(key);
      this.aggEdges.delete(key);
      return;
    }
    let merged: GraphEdge | null = null;
    for (const e of members) {
      const ein = this.edgeInputs[e];
      const s = this.sceneIdByNode[ein.source]!;
      const t = this.sceneIdByNode[ein.target]!;
      if (merged === null) merged = makeEdge(s, t, ein.edge.kind);
      mergeEvidence(merged, ein.edge);
    }
    this.aggEdges.set(key, merged!);
  }

  /** (Re)build a proxy's internal-edge density count from its full member set. */
  private recomputeInternal(rep: number): void {
    const members = this.internalMembers.get(rep);
    if (!members || members.size === 0) {
      this.internalMembers.delete(rep);
      this.internalEdges.delete(rep);
      return;
    }
    this.internalEdges.set(rep, members.size);
  }

  /**
   * The INCREMENTAL recut (design impl point 4 / Gap 9). Apply a {@link CutDiff} against the
   * prior committed scene, touching ONLY:
   *
   *  1. node ordinals under `refined ∪ coarsened` subtree roots (their active representative is
   *     re-resolved; `unchanged` roots' nodes are not visited);
   *  2. the original edge inputs incident to those touched nodes (via the per-ordinal incidence
   *     CSR — boundary edges incident to the changed region, never all edges);
   *  3. the internal-density stats of the affected proxies.
   *
   * Edges whose endpoints' scene ids are both unchanged are reused byte-identical. Falls back to
   * {@link materializeFull} when no baseline exists yet. The optional {@link MaterializeCounter}
   * records exactly how many original nodes/edges were touched (the merge-gate bound).
   */
  applyDiff(nextCut: MaterializeCut, diff: CutDiff, counter?: MaterializeCounter): GraphModel {
    if (!this.committed) return this.materializeFull(nextCut, counter);

    // 1. roll the selection mark forward to the next cut (O(prev + next), not O(reps)).
    //    Clear the prior selection by replaying the prior cut would need it stored; instead we
    //    derive the prior selection from diff (unchanged ∪ refined) and clear exactly those, then
    //    set the next (unchanged ∪ coarsened). This keeps the mark update bounded by the cut size.
    for (let i = 0; i < diff.refined.length; i++) this.selectedMark[diff.refined[i]] = 0;
    for (let i = 0; i < diff.coarsened.length; i++) this.selectedMark[diff.coarsened[i]] = 1;
    // unchanged stay 1 (already set); refined cleared, coarsened set → mark == next cut.

    // 2. collect the touched node ordinals = nodes under any changed subtree root. A node can sit
    //    under both a refined and a coarsened root across recuts but within ONE diff the changed
    //    roots are disjoint subtrees per side; dedupe defensively with a touched mark.
    const touchedNodes: number[] = [];
    const seen = new Set<number>();
    const collect = (roots: Uint32Array) => {
      for (let i = 0; i < roots.length; i++) {
        const { lo, hi } = this.subtreeRange(roots[i]);
        for (let j = lo; j < hi; j++) {
          const ord = this.nodeByDfs[j];
          if (seen.has(ord)) continue;
          seen.add(ord);
          touchedNodes.push(ord);
        }
      }
    };
    collect(diff.refined);
    collect(diff.coarsened);

    // 3. gather the touched EDGE inputs (incident to any touched node), de-duplicated.
    const touchedEdges: number[] = [];
    {
      const seenEdge = new Set<number>();
      for (const ord of touchedNodes) {
        const start = this.incOffsets[ord];
        const end = this.incOffsets[ord + 1];
        for (let k = start; k < end; k++) {
          const e = this.incEntries[k];
          if (seenEdge.has(e)) continue;
          seenEdge.add(e);
          touchedEdges.push(e);
        }
      }
    }

    // 4. REMOVE each touched edge from its PRIOR membership (read with the still-prior scene ids,
    //    BEFORE any scene id is overwritten) — dirtying the keys / internal proxies it leaves. The
    //    aggregate is recomputed from MEMBERS at the end, so this is an exact removal even though
    //    evidence merge is not reversible.
    const dirtyKeys = new Set<string>();
    const dirtyInternal = new Set<number>();
    for (const e of touchedEdges) {
      const ein = this.edgeInputs[e];
      const s = this.sceneIdByNode[ein.source];
      const t = this.sceneIdByNode[ein.target];
      if (s === null || t === null) continue;
      if (s === t) {
        const rep = repOfProxyId(s);
        if (Number.isNaN(rep)) continue;
        this.internalMembers.get(rep)?.delete(e);
        dirtyInternal.add(rep);
      } else {
        const key = edgeId(s, t, ein.edge.kind);
        this.membersByKey.get(key)?.delete(e);
        dirtyKeys.add(key);
      }
    }

    // 5. re-resolve the scene id of each touched node; maintain the per-proxy leaf counts by
    //    removing the OLD proxy's tally and adding the NEW one.
    for (const ord of touchedNodes) {
      if (counter) counter.nodesScanned++;
      const oldSid = this.sceneIdByNode[ord];
      const newSid = this.resolveSceneId(ord);
      if (oldSid === newSid) continue;
      if (oldSid !== null) {
        const oldRep = repOfProxyId(oldSid);
        if (!Number.isNaN(oldRep)) {
          const c = (this.leafCount.get(oldRep) ?? 0) - 1;
          if (c <= 0) this.leafCount.delete(oldRep);
          else this.leafCount.set(oldRep, c);
        }
      }
      if (newSid !== null) {
        const newRep = repOfProxyId(newSid);
        if (!Number.isNaN(newRep))
          this.leafCount.set(newRep, (this.leafCount.get(newRep) ?? 0) + 1);
      }
      this.sceneIdByNode[ord] = newSid;
    }

    // 6. ADD each touched edge to its NEW membership (current scene ids) — dirtying the keys /
    //    internal proxies it joins.
    for (const e of touchedEdges) {
      if (counter) counter.edgesScanned++;
      const ein = this.edgeInputs[e];
      const s = this.sceneIdByNode[ein.source];
      const t = this.sceneIdByNode[ein.target];
      if (s === null || t === null) continue;
      if (s === t) {
        const rep = repOfProxyId(s);
        if (Number.isNaN(rep)) continue;
        let set = this.internalMembers.get(rep);
        if (!set) this.internalMembers.set(rep, (set = new Set()));
        set.add(e);
        dirtyInternal.add(rep);
      } else {
        const key = edgeId(s, t, ein.edge.kind);
        let set = this.membersByKey.get(key);
        if (!set) this.membersByKey.set(key, (set = new Set()));
        set.add(e);
        dirtyKeys.add(key);
      }
    }

    // 7. recompute ONLY the dirtied aggregate keys / internal proxies from their (bounded) members.
    //    A non-touched edge can neither leave nor join a key (both its endpoints' scene ids are
    //    unchanged), so a non-dirty key keeps its prior aggregate byte-identical — the reuse goal.
    for (const key of dirtyKeys) this.recomputeKey(key);
    for (const rep of dirtyInternal) this.recomputeInternal(rep);

    return this.snapshotScene();
  }

  /** Materialize the current state into a fresh GraphModel (nodes + edges). */
  private snapshotScene(): GraphModel {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < this.nodeCount; i++) {
      const sid = this.sceneIdByNode[i];
      if (sid === null) continue;
      if (!isProxyId(sid)) nodes.push(this.graph.nodes[i]); // own node rendered verbatim
    }
    const proxyReps = [...this.leafCount.keys()].sort((a, b) => a - b);
    for (const rep of proxyReps)
      nodes.push(proxyNodeFor(this.hierarchy, rep, this.leafCount.get(rep) ?? 0));
    return { nodes, edges: [...this.aggEdges.values()] };
  }
}
