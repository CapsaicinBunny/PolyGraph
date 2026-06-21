import { buildView, type ViewEdgeKind } from "../aggregate";
import {
  type ClusterBox,
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
  type LayoutInput,
  type LayoutOptions,
  nodeSize,
  type XYPosition,
} from "../layout";
import { buildSmartGroupingSnapshot } from "../layout/smart";
import { facetGrouping, type GroupingHierarchy, packageGrouping } from "./grouping";
import { buildFlatGroupingSnapshot, type CompactGroupingSnapshot } from "./grouping-snapshot";
import { facetKeyOfGroupBy } from "./group-by-options";
import type { PackageManifest } from "./levels/types";
import type { EdgeEvidence, ExternalKind, GraphModel, NodeKind, NodeRole } from "./types";
import { detectCommunities } from "../layout/community";
import { edgeWeight } from "../layout/weight";
import { clientCatalog } from "./client-catalog";
import { collapseClusters } from "./collapse";
import {
  buildProxyEdgeInputs,
  type MaterializeCut,
  materializeProxyScene,
} from "./proxy-materialize";
import type { RepresentationHierarchy } from "./representation";
import type { DimensionCatalog, FacetKey } from "./dimensions";
import { buildDimensionIndex, type DimensionIndex } from "./dimension-index";
import { type FacetSelection, facetAllows, serializeFacetSelections } from "./facet-selection";
import { fileLanguage, topFolderOf } from "./filters";
import {
  EDGE_STYLES,
  glyphFor,
  type IconShape,
  iconShapeFor,
  type LangBadge,
  languageBadge,
  nodeStyle,
} from "./visual";

export interface SceneFilters {
  showExternal: boolean;
  /**
   * Sparse, registry-driven facet selections — the generic replacement for the
   * old enabledNodeKinds/Categories/Environments/Runtimes sets. Gates every
   * filterable dimension EXCEPT folder + language (which keep their dedicated
   * sets below): kind, category, env, runtime, role, and any provider facet.
   * No entry for a key ⇒ all of its values enabled.
   */
  enabledFacets: Map<FacetKey, FacetSelection>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
}

/**
 * Filterable dimensions that, like the old gate, apply to **symbols only** — a
 * file card is typed "file" and carries no symbol-category, so the symbol-type
 * filters never hide files (files are gated by folder/language plus the
 * file-level env/runtime directives). Every other filterable dim (env, runtime,
 * role, future provider facets) gates all non-external nodes.
 */
const SYMBOL_ONLY_FILTER_DIMS: ReadonlySet<FacetKey> = new Set(["kind", "category"]);

/** Folder + language keep dedicated Sets, so the generic facet gate skips them. */
const DEDICATED_STRUCTURAL_DIMS: ReadonlySet<FacetKey> = new Set(["folder", "language"]);

/**
 * The DimensionIndex is a pure function of (graph, catalog), so cache it per pair
 * — a filter toggle rebuilds the scene but must NOT re-intern the columnar index
 * (prohibitive on a 1.3M-node graph). Keyed first by catalog, then weakly by
 * graph, so both are GC'd with the analysis they belong to.
 */
const indexCache = new WeakMap<DimensionCatalog, WeakMap<GraphModel, DimensionIndex>>();

function indexFor(graph: GraphModel, catalog: DimensionCatalog): DimensionIndex {
  let byGraph = indexCache.get(catalog);
  if (!byGraph) {
    byGraph = new WeakMap();
    indexCache.set(catalog, byGraph);
  }
  let index = byGraph.get(graph);
  if (!index) {
    index = buildDimensionIndex(graph, catalog);
    byGraph.set(graph, index);
  }
  return index;
}

/** Filterable dims the generic enabledFacets gate covers (everything but folder/language). */
function gatedFilterDims(catalog: DimensionCatalog): FacetKey[] {
  return catalog.descriptors
    .filter((d) => d.filterable && !DEDICATED_STRUCTURAL_DIMS.has(d.key))
    .map((d) => d.key);
}

export interface SceneNode {
  id: string;
  /** Top-left position; 0,0 until a layout is applied. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: NodeKind;
  role?: NodeRole;
  externalKind?: ExternalKind;
  label: string;
  glyph: string;
  /** Vector icon shape (drawn by the Vello renderer). */
  shape: IconShape;
  /** Language badge (code + color) shown inside a file node's icon. */
  lang?: LangBadge;
  /** Accent color (border / glyph), from role/external/kind. */
  color: string;
  symbolCount: number;
  isFile: boolean;
  isExternal: boolean;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  kind: ViewEdgeKind;
  color: string;
  dashed: boolean;
  toExternal: boolean;
  occurrences: EdgeEvidence[];
  count: number;
  /** Underlying graph-edge ids merged into this edge (the relationships behind it). */
  originalEdgeIds: string[];
}

/** Geometry-free scene: nodes (unpositioned) + edges + the inputs to compute a layout. */
export interface SceneStructure {
  nodes: SceneNode[];
  edges: SceneEdge[];
  signature: string;
  layoutInput: LayoutInput;
  options: LayoutOptions;
  /**
   * The POST-FILTER visible base-node ids (files + symbols that survive the active filters),
   * BEFORE collapse (Gap 7 — "Cut is not clearly post-filter"). The representation cut builds
   * its hierarchy from this projection so filtered-out nodes add no proxy-subtree cost / card
   * pressure and no proxy exists only because of hidden nodes. Pre-collapse, so a collapsed
   * (but visible) group's members are still counted.
   */
  visibleNodeIds: Set<string>;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}

let graphCounter = 0;
const graphIds = new WeakMap<object, string>();

/** Stable per-analysis id so the layout cache signature can't collide across scans. */
export function graphKeyFor(graph: GraphModel): string {
  let id = graphIds.get(graph);
  if (!id) {
    graphCounter += 1;
    id = String(graphCounter);
    graphIds.set(graph, id);
  }
  return id;
}

let catalogCounter = 0;
const catalogIds = new WeakMap<DimensionCatalog, string>();

/**
 * Stable per-catalog id folded into the layout signature. Two analyses can gate
 * the SAME graph by different catalogs (e.g. the kernel's merged catalog on the
 * canvas vs. the TS/JS fallback) and produce different visible node sets; without
 * a catalog component the signatures would collide and one would serve the other's
 * cached positions (filtered-out nodes reappearing at 0,0). The TS/JS fallback is a
 * stable singleton, so this is "1" everywhere on the fallback path.
 */
export function catalogKeyFor(catalog: DimensionCatalog): string {
  let id = catalogIds.get(catalog);
  if (!id) {
    catalogCounter += 1;
    id = String(catalogCounter);
    catalogIds.set(catalog, id);
  }
  return id;
}

function ser<T>(set: Set<T>): string {
  return [...set].map(String).sort().join(",");
}

/**
 * Build the Smart layout grouping snapshot for the active mode (Phase C1a). Directory
 * and Community use the byte-identical buildClusterTree path; Package and facet build a
 * FLAT snapshot from their grouping hierarchy — resolved over the FULL graph (which
 * carries the facets/manifest info the bare layout nodes lack), then projected onto the
 * post-collapse layout node ids (so empty groups are pruned and aggregates fall to root).
 */
function buildGroupingSnapshotForMode(
  layoutInput: LayoutInput,
  groupBy: GroupBy,
  communityOf: Map<string, string> | undefined,
  graph: GraphModel,
  catalog: DimensionCatalog,
  manifests: PackageManifest[],
): CompactGroupingSnapshot {
  const facetKey = facetKeyOfGroupBy(groupBy);
  let hierarchy: GroupingHierarchy | null = null;
  if (groupBy === "package") hierarchy = packageGrouping(graph, manifests);
  else if (facetKey) {
    const descriptor = catalog.descriptors.find((d) => d.key === facetKey);
    if (descriptor) hierarchy = facetGrouping(graph, descriptor);
  }
  if (hierarchy) {
    const h = hierarchy;
    return buildFlatGroupingSnapshot(
      layoutInput.nodes.map((n) => n.id),
      groupBy,
      (nodeId) => {
        const gid = h.groupOfNode(nodeId);
        return gid == null ? null : { id: gid, boxKey: h.boxKey(gid), label: h.label(gid) };
      },
    );
  }
  // A `facet:*` mode whose grouping can't be resolved — the facet was dropped from the
  // catalog, or it is multi-valued with `grouping: disabled` (so facetGrouping returned
  // null) — must NOT silently fall through to the DIRECTORY cluster tree (that would lay a
  // graph out by folders while the UI says "grouped by env"). Emit a flat, boxless
  // ('none'-like) snapshot instead: every node NO_GROUP, zero containers — the honest
  // "this mode imposes no grouping here" result. The synthetic-None safety hierarchy still
  // bounds the budget via the cut path; only the layout containers are dropped.
  if (facetKey) {
    return buildFlatGroupingSnapshot(
      layoutInput.nodes.map((n) => n.id),
      groupBy,
      () => null,
    );
  }
  // Directory / Community / unknown built-in → the byte-identical buildClusterTree path.
  return buildSmartGroupingSnapshot(layoutInput, groupBy, communityOf, groupBy);
}

/**
 * Build the geometry-free scene (filter -> view -> styled nodes/edges) plus the layout
 * input + signature. Pure and synchronous; the layout itself runs separately (worker).
 */
export function buildSceneStructure(
  graph: GraphModel,
  expanded: Set<string>,
  filters: SceneFilters,
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection,
  collapsedClusters: Set<string> = new Set(),
  groupBy: GroupBy = "directory",
  density = 1,
  communityCollapse = false,
  focusedIds: Set<string> | null = null,
  /** Restrict to these base-node ids (query "filter" mode); intersects with filters. */
  queryIds: Set<string> | null = null,
  /** Package/Workspace projection: nodes aren't files, so skip the facet gates. */
  projected = false,
  /**
   * The dimension catalog to gate facets by. The same catalog the Sidebar derives
   * its sections from, so the gate and the controls always agree. Defaults to the
   * TS/JS fallback so the TS-only path (no `result.dimensions`) still filters.
   */
  catalog: DimensionCatalog = clientCatalog(undefined),
  /** Package manifests, for the "package" grouping mode's layout snapshot (else []). */
  manifests: PackageManifest[] = [],
): SceneStructure {
  const { showExternal, enabledFacets, enabledEdgeKinds, enabledFolders, enabledLanguages } =
    filters;

  // The interned, columnar index over (graph, catalog) — cached per pair so a
  // filter toggle never re-interns. The gate reads node values by ordinal.
  const index = indexFor(graph, catalog);
  // Prune the gate to the dimensions that can actually hide a node. An unconstrained
  // selection (no entry / mode "all" / empty "exclude") always passes via facetAllows,
  // so resolving every node's interned values for it is wasted work — UNLESS the
  // dimension's MissingPolicy.filter is "exclude", where a value-less node is hidden
  // even with everything enabled (so it must stay gated to preserve that outcome). On
  // the default-filter path (and throughout camera/LOD interaction, which re-runs this
  // whole O(nodes) pass) nothing is constrained, so the per-node loop drops to ~zero
  // work. Behavior-identical to gating every dim.
  const gatedDims = gatedFilterDims(catalog).filter((key) => {
    const sel = enabledFacets.get(key);
    const constrained =
      sel !== undefined && sel.mode !== "all" && !(sel.mode === "exclude" && sel.values.size === 0);
    if (constrained) return true;
    return index.descriptor(key)?.missing.filter === "exclude";
  });

  // In focus mode, also surface the parent file of any focused *symbol* so the symbols
  // have a container to nest in. Without it the view drops symbols whose file isn't
  // shown/expanded — focusing a symbol-level finding (e.g. a function↔function cycle)
  // would render an empty canvas, while file-level findings worked.
  const focusParents = new Set<string>();
  if (focusedIds) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const id of focusedIds) {
      const n = byId.get(id);
      if (n && n.kind !== "file" && n.kind !== "external") focusParents.add(n.parentFile);
    }
  }

  // Generic facet gate for one dimension: resolve the node's interned value ids to
  // strings and test them against the sparse selection, honoring MissingPolicy.
  const passesFacet = (ordinal: number, key: FacetKey): boolean => {
    const descriptor = index.descriptor(key);
    if (!descriptor) return true;
    const values = index.valuesOfOrdinal(ordinal, key).map((id) => index.valueString(key, id));
    return facetAllows(enabledFacets, key, values, descriptor.missing.filter);
  };

  const visible = (n: GraphModel["nodes"][number], ordinal: number) => {
    // Focus mode shows exactly the focused subgraph (plus focused symbols' parent files),
    // overriding the other filters.
    if (focusedIds) return focusedIds.has(n.id) || focusParents.has(n.id);
    // Query filter mode narrows on top of (intersected with) the checkbox filters.
    if (queryIds && !queryIds.has(n.id)) return false;
    // Projected (package/workspace) nodes aren't files/symbols — show them all; the
    // projection itself is the chosen view, and external deps are first-class here.
    if (projected) return true;
    if (n.kind === "external") return showExternal;
    // Folder + language gate — applies to files and the symbols inside them.
    if (!enabledFolders.has(topFolderOf(n.filePath))) return false;
    if (!enabledLanguages.has(fileLanguage(n.filePath).key)) return false;
    const isFile = n.kind === "file";
    // Generic facet gates (kind/category/env/runtime/role/provider facets). Symbol-only
    // dims (kind, category) never gate file cards; everything else gates files too —
    // exactly the legacy ordering (env/runtime applied to files; kind/category did not).
    for (const key of gatedDims) {
      if (isFile && SYMBOL_ONLY_FILTER_DIMS.has(key)) continue;
      if (!passesFacet(ordinal, key)) return false;
    }
    return true;
  };
  const keptNodes = graph.nodes.filter((n, i) => visible(n, i));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const filteredGraph = {
    nodes: keptNodes,
    edges: graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
  };
  // Single source of truth for communities: detect once on the filtered graph,
  // then feed the SAME map to both the collapse transform and the layout so the
  // rendered "Community N" boxes and the collapse targets always agree.
  const communityOf =
    groupBy === "community"
      ? detectCommunities(
          filteredGraph.nodes.map((n) => n.id),
          filteredGraph.edges,
        )
      : undefined;
  // Semantic reduction: collapse chosen directories into aggregate cards before
  // building the view. When "collapse community groups" is on (Community mode), fold
  // EVERY multi-member community into one card — the toggle does the work directly,
  // so the user never has to hit a thin cluster header.
  let effectiveCollapsed = collapsedClusters;
  if (groupBy === "community" && communityCollapse && communityOf) {
    const sizes = new Map<string, number>();
    for (const c of communityOf.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    effectiveCollapsed = new Set(collapsedClusters);
    for (const [community, size] of sizes) if (size > 1) effectiveCollapsed.add(community);
  }
  const sourceGraph = collapseClusters(
    filteredGraph,
    effectiveCollapsed,
    groupBy === "community" && communityCollapse ? communityOf : undefined,
  );
  // Force the focused symbols' parent files open so the symbols render even when the
  // current level/expand state would otherwise keep them collapsed.
  const viewExpanded = focusParents.size > 0 ? new Set([...expanded, ...focusParents]) : expanded;
  const view = buildView(sourceGraph, viewExpanded);
  const visibleEdges = view.edges.filter(
    (e) => e.kind === "contains" || enabledEdgeKinds.has(e.kind),
  );

  const signature = [
    graphKeyFor(graph),
    // Catalog identity: a different gating catalog yields a different visible set,
    // so it must not collide with another catalog's cached layout for this graph.
    `cat:${catalogKeyFor(catalog)}`,
    algorithm,
    direction,
    `x${showExternal ? 1 : 0}`,
    ser(expanded),
    // Canonical (sorted, order-independent) serialization of every facet selection,
    // so a Map insertion-order change can't churn the layout cache.
    `f:${serializeFacetSelections(enabledFacets)}`,
    ser(enabledEdgeKinds),
    ser(enabledFolders),
    ser(enabledLanguages),
    ser(collapsedClusters),
    groupBy,
    `d${density}`,
    `cc${communityCollapse ? 1 : 0}`,
    focusedIds ? `focus:${[...focusedIds].sort().join(",")}` : "focus:none",
    queryIds ? `q:${[...queryIds].sort().join(",")}` : "q:none",
    `p${projected ? 1 : 0}`,
  ].join("|");

  const symbolCount = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") symbolCount.set(n.parentFile, (symbolCount.get(n.parentFile) ?? 0) + 1);
  }

  const externalColor = new Map<string, string>();
  for (const n of view.nodes) {
    if (n.kind === "external")
      externalColor.set(n.id, nodeStyle(n.kind, n.role, n.externalKind).color);
  }

  const nodes: SceneNode[] = view.nodes.map((n) => {
    const size = nodeSize(n.kind);
    return {
      id: n.id,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      kind: n.kind,
      role: n.role,
      externalKind: n.externalKind,
      label: n.label,
      glyph: glyphFor(n.kind, n.role),
      shape: iconShapeFor(n.kind, n.role),
      ...(n.kind === "file" ? { lang: languageBadge(n.label) ?? undefined } : {}),
      color: nodeStyle(n.kind, n.role, n.externalKind).color,
      symbolCount: symbolCount.get(n.id) ?? 0,
      isFile: n.kind === "file",
      isExternal: n.kind === "external",
    };
  });

  const edges: SceneEdge[] = visibleEdges.map((e) => {
    const toExternal = externalColor.get(e.target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      color: toExternal ?? EDGE_STYLES[e.kind].color,
      dashed: e.kind === "contains",
      toExternal: toExternal !== undefined,
      occurrences: e.occurrences,
      count: e.count,
      originalEdgeIds: e.originalEdgeIds,
    };
  });

  const layoutInput: LayoutInput = {
    nodes: view.nodes.map((n) => ({ id: n.id, kind: n.kind })),
    edges: visibleEdges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      count: e.count,
      weight: edgeWeight(e.kind, e.count),
    })),
  };

  // Phase C1a: build the grouping snapshot the Smart layout consumes (the new layout
  // INPUT contract) from the post-filter/post-collapse layout nodes, here on the main
  // thread; its typed arrays transfer to the worker. Only Smart WITH containers uses
  // it — classic engines and Smart+None lay out flat (no cluster tree). Directory and
  // Community go through the byte-identical buildClusterTree path; Package and facet
  // build a flat snapshot from their grouping hierarchy (resolved over the full graph,
  // which carries the facets/manifest info the bare layout nodes lack).
  const groupingSnapshot =
    algorithm === "smart" && groupBy !== "none"
      ? buildGroupingSnapshotForMode(layoutInput, groupBy, communityOf, graph, catalog, manifests)
      : undefined;

  return {
    nodes,
    edges,
    signature,
    layoutInput,
    options: { algorithm, direction, groupBy, density, communityOf, groupingSnapshot },
    // The post-filter visible base nodes (pre-collapse) — the projection the rep cut uses.
    visibleNodeIds: keptIds,
  };
}

/**
 * The GENERIC proxy scene materialization wiring (design Gap 1 + P1). Given the committed
 * representation cut (its hierarchy + selected reps) and the POST-FILTER graph the cut was
 * built over, produce the folded GraphModel — proxy aggregate cards for committed proxies plus
 * raw nodes whose own leaf rep is selected, with edges aggregated between active
 * representatives. This is the authoritative P1 replacement for {@link collapseClusters}'
 * directory/community-only absorption: it folds Directory / Community / Package / facet / None
 * cuts UNIFORMLY (working off rep identity, not box keys or path prefixes).
 *
 * The post-filter graph's node order MUST match the hierarchy's node ordinals (the same
 * `nodeIds` the rep cut was built from), so a node's ordinal is its index in `graph.nodes`.
 * The result drops into {@link buildView}/{@link buildSceneStructure} exactly like the old
 * collapse output — no renderer change. Pure.
 */
export function materializeRepresentationScene(
  graph: GraphModel,
  hierarchy: RepresentationHierarchy,
  cut: MaterializeCut,
  options: {
    /** Post-filter visibility by node ordinal (hidden nodes are detached from the scene). */
    visibleNode?: (ordinal: number) => boolean;
  } = {},
): GraphModel {
  // node id → ordinal (its index in the hierarchy's node order == graph.nodes order).
  const ordinalOfNode = new Map<string, number>();
  for (let i = 0; i < graph.nodes.length; i++) ordinalOfNode.set(graph.nodes[i].id, i);
  const edgeInputs = buildProxyEdgeInputs(graph, (id) => ordinalOfNode.get(id));
  return materializeProxyScene({
    hierarchy,
    cut,
    graph,
    visibleNode: options.visibleNode,
    edgeInputs,
  });
}

/** Apply computed positions + cluster boxes to a structure, producing a renderable scene. */
export function applyPositions(
  structure: SceneStructure,
  positions: Map<string, XYPosition>,
  clusters: ClusterBox[] = [],
): Scene {
  const nodes = structure.nodes.map((n) => {
    const p = positions.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
  return { nodes, edges: structure.edges, positions, clusters };
}
