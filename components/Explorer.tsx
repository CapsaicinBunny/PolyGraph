"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Flex, Heading, HStack, Image, Text } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { BUILTIN_SEARCHES, runQuery, type SavedSearch } from "@/lib/graph/query-language";
import {
  packageNameResolver,
  projectToPackages,
  projectToWorkspaces,
} from "@/lib/graph/levels/packages";
import type { Level, PackageManifest } from "@/lib/graph/levels/types";
import type { QueryMode } from "./QueryBar";
import type { AnalyzeResult, GraphModel } from "@/lib/graph/types";
import { FILTERABLE_EDGE_KINDS } from "@/lib/graph/visual";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "@/lib/layout";
import {
  availableFolders,
  availableLanguages,
  DEFAULT_HIDDEN_LANGUAGES,
} from "@/lib/graph/filters";
import type { FacetKey } from "@/lib/graph/dimensions";
import {
  type FacetSelection,
  serializeFacetSelections,
  setFacetValues,
  toggleFacetValue,
} from "@/lib/graph/facet-selection";
import { clientCatalog } from "@/lib/graph/client-catalog";
import { buildDimensionIndex } from "@/lib/graph/dimension-index";
import { deriveFilterDimensions } from "@/lib/graph/filter-derive";
import { autoCollapseDirs, type AutoCollapse } from "@/lib/graph/auto-collapse";
import { buildDirTree, type DirNode, dirIndex } from "@/lib/graph/hierarchy";
import { type CollapseIntent, compose, type GroupId } from "@/lib/graph/collapse-model";
import {
  allDirectoryGroupIds,
  ancestorDirectoryGroupIds,
  communityGrouping,
  directoryGroupId,
  facetGrouping,
  type GroupingHierarchy,
  packageGrouping,
  toDirectoryBoxKeys,
  toDirectoryGroupIds,
} from "@/lib/graph/grouping";
import { buildGroupingSnapshot, type CompactGroupingSnapshot } from "@/lib/graph/grouping-snapshot";
import { budgetGroupCut, groupLodSelection } from "@/lib/graph/group-cut";
import { deriveGroupByOptions, facetKeyOfGroupBy } from "@/lib/graph/group-by-options";
import { FiltersPanel } from "./FiltersPanel";
import { graphKeyFor, type SceneEdge } from "@/lib/graph/scene";
import { EdgeDetailPanel } from "./EdgeDetailPanel";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { analyzeInsights, unresolvedToInsights } from "@/lib/graph/insights";
import { ProblemsPanel } from "./ProblemsPanel";
import { ExportPanel } from "./ExportPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { UploadDropzone } from "./UploadDropzone";
import type { ExplorerWorkspaceState } from "@/lib/workspace/schema";
import { isTauri } from "@/lib/client/env";
import { telemetry } from "@/lib/telemetry";
import { startSessionLogPersist } from "@/lib/telemetry/persist";

// Vello renders via WebGPU (browser-only), so load it client-side.
const VelloGraphCanvas = dynamic(
  () => import("./VelloGraphCanvas").then((m) => m.VelloGraphCanvas),
  { ssr: false },
);

// Above this many file nodes, auto-collapse directories so the initial scene the
// renderer receives stays drawable (LOD v0; see docs/SCALE-100K.md).
const AUTO_COLLAPSE_MAX_CARDS = 2000;
// Cap on estimated layout NODES (files + their symbols when expanded) used to seed
// the collapse on expand-all. Keeps the layout input small enough for Smart to finish
// within the worker timeout instead of falling back to grid. Matches LOD_NODE_BUDGET
// in VelloGraphCanvas. See docs/superpowers/plans/2026-06-18-nanite-lod-node-budget.md.
const LOD_NODE_BUDGET = 2500;

// The grouping mode whose collapse intent C0 wires. Directory only here; Package /
// Community / facet become peer modes (each with its own intent map) in later phases.
const DIRECTORY_MODE = "directory";
// Stable empty intent/set so the derived collapse memo doesn't churn before any user action.
const EMPTY_INTENT: CollapseIntent = new Map();
const EMPTY_SET: ReadonlySet<GroupId> = new Set();

interface Stats {
  fileCount: number;
  skipped: number;
}

export function Explorer() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [manifests, setManifests] = useState<PackageManifest[]>([]);
  const [level, setLevel] = useState<Level>("file");
  const [stats, setStats] = useState<Stats | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Three-layer directory collapse (Phase C0; spec "Three-layer collapse"). The old
  // single `collapsedClusters` set had FIVE writers and the camera clobbered user intent.
  //   • intentByMode  — ONLY user actions (manual drill, collapse-all), per grouping mode.
  //   • bootstrapClosed — derived SAFETY: the adaptive-LOD seed closes the whole directory
  //     universe so the camera's selection can OPEN regions; ∅ when LOD is off.
  //   • lodSelection  — the camera's transitional open-directory set (owns nothing else).
  // The effective collapsed set is composed from these (below); user intent can never be
  // clobbered by the camera. Namespaced GroupIds ("directory:<path>"); translated to the
  // bare layout/LOD path at the boundary.
  // All three layers are keyed by grouping mode (Phase C1a): switching modes preserves
  // each mode's collapse state. C0 wired Directory only; the camera selection + bootstrap
  // are now per-mode too. The active mode is `groupBy` (the modeKey).
  const [intentByMode, setIntentByMode] = useState<Map<string, CollapseIntent>>(() => new Map());
  const [bootstrapByMode, setBootstrapByMode] = useState<Map<string, Set<GroupId>>>(
    () => new Map(),
  );
  const [selectionByMode, setSelectionByMode] = useState<Map<string, Set<GroupId>>>(
    () => new Map(),
  );
  // The community assignment the SCENE actually laid out (detected over the FILTERED
  // graph), reported up from the canvas. The cut snapshot below must reuse it so its
  // "Community N" box keys match the rendered boxes — re-detecting over the full graph
  // here would relabel communities under active filters and silently disable LOD in
  // Community mode (the cut would find no matching box for any group). Null until the
  // first scene lands, or in non-community modes.
  const [communityCutOf, setCommunityCutOf] = useState<Map<string, string> | null>(null);
  const [enabledEdgeKinds, setEnabledEdgeKinds] = useState<Set<ViewEdgeKind>>(
    () => new Set(FILTERABLE_EDGE_KINDS),
  );
  // Sparse, registry-driven facet selections (kind/category/env/runtime/role +
  // any provider facet) — replaces the four named enabled* sets. Empty map ⇒ all
  // values of every facet enabled; the dimension spine gate + the dynamic Sidebar
  // both read from this.
  const [enabledFacets, setEnabledFacets] = useState<Map<FacetKey, FacetSelection>>(
    () => new Map(),
  );
  const [search, setSearch] = useState("");
  const [queryMode, setQueryMode] = useState<QueryMode>("filter");
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<SceneEdge | null>(null);
  const [algorithm, setAlgorithm] = useState<LayoutAlgorithm>("smart");
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [groupBy, setGroupBy] = useState<GroupBy>("directory");
  const [density, setDensity] = useState(1);
  const [showExternal, setShowExternal] = useState(false);
  const [enabledFolders, setEnabledFolders] = useState<Set<string>>(() => new Set());
  const [enabledLanguages, setEnabledLanguages] = useState<Set<string>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [edgeRouting, setEdgeRouting] = useState<"curved" | "orthogonal">("curved");
  const [communityCollapse, setCommunityCollapse] = useState(false);
  const [focusedIds, setFocusedIds] = useState<Set<string> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  // Adaptive level-of-detail (LOD): recompute the collapsed cut as the camera
  // zooms so a huge repo stays drawable. Off by default — see docs/SCALE-100K.md.
  const [adaptiveLod, setAdaptiveLod] = useState(true);
  // Navigation minimap overlay (graph extent + viewport rect). Default on; toggle
  // in Settings. Helps re-find the graph when zoomed out / panned out of bounds.
  const [minimap, setMinimap] = useState(true);
  // Analytics & logging (telemetry) — mirrors the bus's persisted enabled flag so the
  // Settings toggle reflects and controls it. Default on; persisted to localStorage.
  const [telemetryOn, setTelemetryOn] = useState(telemetry.isEnabled());
  const handleTelemetry = useCallback((v: boolean) => {
    telemetry.setEnabled(v);
    setTelemetryOn(v);
    telemetry.event("scene", "telemetry-toggled", { enabled: v });
  }, []);

  const baseGraph = result?.graph ?? null;

  // Directory-scoped setters for the per-mode layers — the Directory wiring (seed,
  // collapse-all, drill, workspace restore) writes ONLY these, so its behavior is
  // unchanged (byte-identical) while the underlying state is now per-mode. They update the
  // "directory" entry of each per-mode map; the effective set is composed below from the
  // ACTIVE mode's layers.
  const setDirectoryBootstrap = useCallback((set: Set<GroupId>) => {
    setBootstrapByMode((prev) => new Map(prev).set(DIRECTORY_MODE, set));
  }, []);
  const setDirectorySelection = useCallback((set: Set<GroupId>) => {
    setSelectionByMode((prev) => new Map(prev).set(DIRECTORY_MODE, set));
  }, []);

  // Mutate a given grouping mode's collapse intent (the ONLY writer of user intent).
  // Copies the per-mode map so a stale closure can't mutate live state.
  const editIntent = useCallback((mode: string, mutate: (intent: CollapseIntent) => void) => {
    setIntentByMode((prev) => {
      const next = new Map(prev);
      const cur = new Map(next.get(mode) ?? EMPTY_INTENT);
      mutate(cur);
      next.set(mode, cur);
      return next;
    });
  }, []);
  // Directory-scoped intent editor (the Directory wiring writes ONLY this — unchanged).
  const editDirectoryIntent = useCallback(
    (mutate: (intent: CollapseIntent) => void) => editIntent(DIRECTORY_MODE, mutate),
    [editIntent],
  );

  // Seed the two AUTO layers (bootstrap + camera selection) from an auto-collapse result,
  // and clear directory intent. When the graph fits (`seed` null) LOD is off: both layers
  // are empty → nothing collapses. Otherwise the bootstrap closes the whole directory
  // universe (the LOD safety net) and the selection opens everything ABOVE the seed
  // frontier, so the initial render matches the seed exactly while the camera can refine
  // by opening more. This NEVER writes intent — a seed is derived safety, not a user act.
  const seedDirectoryLod = useCallback(
    (g: GraphModel, seed: AutoCollapse | null) => {
      setIntentByMode((prev) => {
        if (!prev.has(DIRECTORY_MODE)) return prev;
        const next = new Map(prev);
        next.delete(DIRECTORY_MODE);
        return next;
      });
      if (!seed) {
        setDirectoryBootstrap(new Set());
        setDirectorySelection(new Set());
        return;
      }
      setDirectoryBootstrap(allDirectoryGroupIds(g));
      const open = new Set<GroupId>();
      for (const path of seed.collapsed)
        for (const anc of ancestorDirectoryGroupIds(path)) open.add(anc);
      setDirectorySelection(open);
    },
    [setDirectoryBootstrap, setDirectorySelection],
  );

  // The active graph reflects the chosen abstraction level. Symbol/File/Directory use the
  // base graph (file/symbol granularity is driven by expand/collapse); Package and
  // Workspace project the base graph through the discovered manifests.
  const projected = level === "package" || level === "workspace";
  const graph = useMemo(() => {
    if (!baseGraph) return null;
    if (level === "package") return projectToPackages(baseGraph, manifests);
    if (level === "workspace") return projectToWorkspaces(baseGraph, manifests);
    return baseGraph;
  }, [baseGraph, level, manifests]);

  const packageOf = useMemo(
    () => (baseGraph ? packageNameResolver(baseGraph, manifests) : undefined),
    [baseGraph, manifests],
  );

  const folders = useMemo(() => (graph ? availableFolders(graph) : []), [graph]);
  const languages = useMemo(() => (graph ? availableLanguages(graph) : []), [graph]);

  // The dimension catalog (the result's own, or the TS/JS fallback) and the
  // runtime index over the ACTIVE graph — the single source the scene gate AND
  // the dynamic Sidebar project from, so controls and filtering always agree.
  const catalog = useMemo(() => clientCatalog(result?.dimensions), [result]);
  const dimensionIndex = useMemo(
    () => (graph ? buildDimensionIndex(graph, catalog) : null),
    [graph, catalog],
  );
  // The filterable facet sections to render: category / env / runtime / role and
  // any provider facet (Rust visibility, Go exported, …) — each with present()
  // values, per-value counts, and eligibility. Empty on a graph with no facets,
  // so a C/Rust project simply shows whichever of its dimensions are present.
  const filterDimensions = useMemo(
    () => (graph && dimensionIndex ? deriveFilterDimensions(graph, catalog, dimensionIndex) : []),
    [graph, catalog, dimensionIndex],
  );
  const insights = useMemo(
    () =>
      graph ? [...analyzeInsights(graph), ...unresolvedToInsights(result?.unresolved ?? [])] : [],
    [graph, result],
  );

  // The eligible Group-by modes for this graph (Phase C1a): Directory, Package (when
  // manifests exist), Community, every eligible groupable facet, then None. Replaces the
  // fixed directory/community/none chips — so a C/Rust repo offers whatever it actually
  // supports. Empty graph → just the built-ins.
  const groupByOptions = useMemo(
    () =>
      graph && dimensionIndex
        ? deriveGroupByOptions(graph, catalog, dimensionIndex, manifests.length > 0)
        : [
            { key: "directory", label: "Directory", glyph: "🗀" },
            { key: "community", label: "Community", glyph: "⬡" },
            { key: "none", label: "None", glyph: "∅" },
          ],
    [graph, catalog, dimensionIndex, manifests.length],
  );

  // If the active mode is no longer offered (e.g. a facet became ineligible after a
  // filter change, or a workspace restored a mode this graph doesn't support), fall back
  // to Directory so the layout never wedges on an unresolvable grouping.
  useEffect(() => {
    if (graph && groupByOptions.length > 0 && !groupByOptions.some((o) => o.key === groupBy)) {
      setGroupBy("directory");
    }
  }, [graph, groupByOptions, groupBy]);

  // Mirror telemetry to logs/session.ndjson on desktop so the LOD/render trace
  // survives a crash (no-op in the browser; Settings "Download session log" there).
  // Also mark the app shell as mounted/hydrated — a startup breadcrumb. (This child effect
  // runs before the root ErrorBoundary's componentDidMount, so "mounted" actually lands just
  // before "session-start" in the log; both bracket startup.)
  useEffect(() => {
    startSessionLogPersist();
    telemetry.event("app", "mounted", { tauri: isTauri() });
  }, []);

  // Load / persist user saved searches.
  const SAVED_KEY = "polygraph.savedSearches";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      if (raw) setSavedSearches(JSON.parse(raw) as SavedSearch[]);
    } catch {
      /* ignore unreadable storage */
    }
  }, []);
  const persistSaved = useCallback((list: SavedSearch[]) => {
    setSavedSearches(list);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }, []);

  // Evaluate the search box as a query against the active level. Empty → no constraint.
  const queryResult = useMemo(
    () => (graph && search.trim() !== "" ? runQuery(graph, search, { packageOf }) : null),
    [graph, search, packageOf],
  );
  const queryError = queryResult?.error;
  const matchedIds =
    queryResult && !queryResult.error && !queryResult.empty ? queryResult.nodeIds : null;
  const queryIds = queryMode === "filter" ? matchedIds : null;
  const highlightIds = queryMode === "highlight" ? matchedIds : null;

  // Signature of everything that should re-frame the camera (new graph, level,
  // filters, focus) but NOT collapsedClusters — so the adaptive cut preserves the
  // user's zoom. Computed whenever a graph is loaded, regardless of adaptive LOD: a
  // click/highlight or a no-op recut leaves it unchanged so only a genuine fit-worthy
  // change re-frames. (It used to be undefined when LOD was off, which made shouldFit()
  // always true → every click/zoom-recut re-fit the camera to min zoom.)
  const fitSignature = useMemo(() => {
    if (!graph) return undefined;
    const set = (s: Set<string>) => [...s].sort().join(",");
    return [
      graphKeyFor(graph),
      level,
      algorithm,
      direction,
      groupBy,
      density,
      edgeRouting,
      showExternal ? 1 : 0,
      communityCollapse ? 1 : 0,
      set(enabledEdgeKinds as Set<string>),
      // Canonical, order-independent facet serialization (kind/category/env/runtime/role/…).
      `f:${serializeFacetSelections(enabledFacets)}`,
      set(enabledFolders),
      set(enabledLanguages),
      set(expanded),
      focusedIds ? set(focusedIds) : "",
      queryIds ? set(queryIds) : "",
    ].join("|");
  }, [
    graph,
    level,
    algorithm,
    direction,
    groupBy,
    density,
    edgeRouting,
    showExternal,
    communityCollapse,
    enabledEdgeKinds,
    enabledFacets,
    enabledFolders,
    enabledLanguages,
    expanded,
    focusedIds,
    queryIds,
  ]);

  const handleSaveSearch = useCallback(() => {
    const q = search.trim();
    if (!q) return;
    const name = window.prompt("Name this search", q.slice(0, 40))?.trim();
    if (!name) return;
    persistSaved([...savedSearches.filter((s) => s.name !== name), { name, query: q }]);
  }, [search, savedSearches, persistSaved]);

  const handleDeleteSearch = useCallback(
    (name: string) => persistSaved(savedSearches.filter((s) => s.name !== name)),
    [savedSearches, persistSaved],
  );

  const resetFileFilters = useCallback((g: typeof graph) => {
    if (!g) return;
    setEnabledFolders(new Set(availableFolders(g).map((f) => f.name)));
    setEnabledLanguages(
      new Set(
        availableLanguages(g)
          .filter((l) => !DEFAULT_HIDDEN_LANGUAGES.has(l.key))
          .map((l) => l.key),
      ),
    );
  }, []);

  // Expand/collapse always operates on real files, so derive these from the base graph
  // (the projected Package/Workspace graphs have no file nodes).
  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of baseGraph?.nodes ?? []) map.set(n.id, n.parentFile);
    return map;
  }, [baseGraph]);

  // Symbols per file id — feeds the LOD node budget so the cut and the expand-all seed
  // account for the symbols an expanded file pulls into the layout, not just the card.
  const symbolCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of baseGraph?.nodes ?? []) {
      if (n.kind !== "file") map.set(n.parentFile, (map.get(n.parentFile) ?? 0) + 1);
    }
    return map;
  }, [baseGraph]);

  // Directory tree: an index (path → node) so drilling into an aggregate reveals just
  // its immediate child directories, plus the top-level dir paths for "Collapse all".
  const dirTree = useMemo(() => (baseGraph ? buildDirTree(baseGraph) : null), [baseGraph]);
  const dirNodes = useMemo<Map<string, DirNode>>(
    () => (dirTree ? dirIndex(dirTree) : new Map()),
    [dirTree],
  );
  const topDirs = useMemo(() => dirTree?.children.map((c) => c.path) ?? [], [dirTree]);

  // The active grouping mode's CUT hierarchy + snapshot, for the mode-agnostic adaptive
  // cut (Phase C1a). Directory keeps its dedicated DirNode path (byte-identical) so it
  // builds no snapshot here; Community (and later Package/facet) build one over the
  // active graph so the camera can run computeGroupCut. None has no visible containers,
  // so it builds none — the cut is inert for it (its budget is bounded elsewhere).
  const cutGrouping = useMemo<{
    hierarchy: GroupingHierarchy;
    snapshot: CompactGroupingSnapshot;
  } | null>(() => {
    if (!graph || groupBy === "directory" || groupBy === "none") return null;
    let hierarchy: GroupingHierarchy | null = null;
    // Community: reuse the SCENE's community map (detected over the filtered graph) so
    // the cut's box keys match the rendered boxes. Until the canvas reports it (first
    // scene), skip — building over the full graph here would diverge under filters.
    if (groupBy === "community") {
      if (!communityCutOf) return null;
      hierarchy = communityGrouping(graph, communityCutOf);
    } else if (groupBy === "package") hierarchy = packageGrouping(graph, manifests);
    else {
      const facetKey = facetKeyOfGroupBy(groupBy);
      if (facetKey) {
        const descriptor = catalog.descriptors.find((d) => d.key === facetKey);
        if (descriptor) hierarchy = facetGrouping(graph, descriptor);
      }
    }
    if (!hierarchy) return null;
    const snapshot = buildGroupingSnapshot(
      hierarchy,
      groupBy,
      graph.nodes.map((n) => n.id),
    );
    return { hierarchy, snapshot };
  }, [graph, groupBy, manifests, catalog, communityCutOf]);

  // Seed the non-directory modes' AUTO collapse layers (bootstrap + camera selection)
  // from a geometry-free budget cut over the active snapshot — the mode-agnostic mirror
  // of seedDirectoryLod. Without this the cut was INERT for Community/Package/facet: the
  // bootstrap stayed empty, so compose() discarded the camera's selection and changing
  // the group mode effectively disabled LOD (the C1a bug). The bootstrap closes the whole
  // group universe ("everything starts closed"); the selection opens the budgeted
  // frontier so the first frame is bounded before the camera moves; both are cleared (LOD
  // off, everything open) when the graph already fits. NEVER writes intent — a seed is
  // derived safety. Directory keeps its dedicated seedDirectoryLod path (untouched).
  useEffect(() => {
    if (groupBy === "directory") return; // Directory is seeded by seedDirectoryLod
    const snap = cutGrouping?.snapshot;
    if (!adaptiveLod || !snap) {
      // No snapshot (e.g. None, or pre-scene) or LOD off → clear this mode's auto layers.
      setBootstrapByMode((prev) => {
        if (!prev.has(groupBy)) return prev;
        return new Map(prev).set(groupBy, new Set());
      });
      setSelectionByMode((prev) => {
        if (!prev.has(groupBy)) return prev;
        return new Map(prev).set(groupBy, new Set());
      });
      return;
    }
    // cutGrouping (and thus snap) only exists when graph is non-null, and snap is keyed by
    // graph.nodes order — so the full id list is the correct nodeIds for the cost lookups.
    const cost = (id: string) => 1 + (symbolCount.get(id) ?? 0);
    const nodeIds = graph ? graph.nodes.map((n) => n.id) : [];
    const collapsed = budgetGroupCut(
      snap,
      { maxCards: AUTO_COLLAPSE_MAX_CARDS, nodeBudget: LOD_NODE_BUDGET, nodeCost: cost },
      nodeIds,
    );
    if (collapsed === null) {
      // The whole snapshot fits — leave everything open, no bootstrap (LOD effectively off
      // for this mode until the user/camera narrows). Mirrors Directory's `seed === null`.
      setBootstrapByMode((prev) => new Map(prev).set(groupBy, new Set()));
      setSelectionByMode((prev) => new Map(prev).set(groupBy, new Set()));
      return;
    }
    const bootstrap = new Set<GroupId>(snap.groupIds); // everything starts closed
    const selection = groupLodSelection(collapsed, snap); // open the budgeted frontier
    setBootstrapByMode((prev) => new Map(prev).set(groupBy, bootstrap));
    setSelectionByMode((prev) => new Map(prev).set(groupBy, selection));
    // Intent is the user's; a seed must not touch it (only clear is via Reset elsewhere).
  }, [groupBy, cutGrouping, adaptiveLod, symbolCount, graph]);

  // Receive the SCENE's community assignment (filtered-graph detection) so the cut
  // snapshot reuses it. Only meaningful in Community mode; cleared otherwise so a stale
  // map can't leak into a later Community session.
  const handleCommunityOf = useCallback((map: Map<string, string> | null) => {
    setCommunityCutOf((prev) => {
      if (prev === map) return prev;
      if (prev && map && prev.size === map.size) {
        // Cheap identity guard: same size AND same entries ⇒ no state churn.
        let same = true;
        for (const [k, v] of map)
          if (prev.get(k) !== v) {
            same = false;
            break;
          }
        if (same) return prev;
      }
      return map;
    });
  }, []);

  // The effective collapsed set (box keys) for the ACTIVE grouping mode, composed from
  // that mode's three layers. This is the single value the scene pipeline consumes — it
  // drops in exactly where the old `collapsedClusters` state did. Precedence (inside
  // compose): user-closed > user-open > camera selection-open > bootstrap > default-open.
  // Directory converts namespaced ids → bare paths; other modes convert via the cut
  // snapshot's groupId→boxKey map.
  const activeIntent = intentByMode.get(groupBy) ?? EMPTY_INTENT;
  const activeBootstrap = bootstrapByMode.get(groupBy) ?? EMPTY_SET;
  const activeSelection = selectionByMode.get(groupBy) ?? EMPTY_SET;
  const collapsedClusters = useMemo(() => {
    const composed = compose({
      intent: activeIntent,
      bootstrapClosed: activeBootstrap,
      selection: activeSelection,
    });
    if (groupBy === "directory") return toDirectoryBoxKeys(composed);
    // Non-directory: map each composed namespaced group id to its layout box key.
    const snap = cutGrouping?.snapshot;
    if (!snap) return new Set<string>();
    const boxKeyOf = new Map<GroupId, string>();
    for (let g = 0; g < snap.groupIds.length; g++)
      boxKeyOf.set(snap.groupIds[g], snap.boxKeyByGroup[g]);
    const out = new Set<string>();
    for (const id of composed) {
      const bk = boxKeyOf.get(id);
      if (bk !== undefined) out.add(bk);
    }
    return out;
  }, [groupBy, activeIntent, activeBootstrap, activeSelection, cutGrouping]);

  const fileIds = useMemo(
    () => (baseGraph?.nodes ?? []).filter((n) => n.kind === "file").map((n) => n.id),
    [baseGraph],
  );
  const allExpanded = fileIds.length > 0 && fileIds.every((id) => expanded.has(id));

  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      // Collapse all → the coarsest overview: every top-level directory as one aggregate.
      // This IS a user action, so it writes 'closed' INTENT on the top-level directories
      // (replacing any prior directory intent) and turns the camera cut OFF — intent now
      // wins over the camera, but clearing the auto layers keeps the result exactly the
      // top dirs. A later zoom can no longer undo the collapse the user just asked for.
      setExpanded(new Set());
      setIntentByMode((prev) => {
        const next = new Map(prev);
        next.set(DIRECTORY_MODE, new Map(topDirs.map((p) => [directoryGroupId(p), "closed"])));
        return next;
      });
      setDirectoryBootstrap(new Set());
      setDirectorySelection(new Set());
      setAdaptiveLod(false);
    } else {
      // "Reveal detail" (was "Expand all") → expand every file's symbols and CLEAR any
      // 'closed' intent, re-seeding the auto LOD layers so detail opens within budget
      // (spec §9). It writes no blanket 'open': if the expanded graph fits the layout
      // budget it shows flat with the cut OFF; only when it's genuinely too big do we seed
      // the dir-collapse AND keep the cut on, bounding the rendered card count (else Smart
      // overruns → grid fallback). seedDirectoryLod clears directory intent for us.
      setExpanded(new Set(fileIds));
      const cost = (id: string) => 1 + (symbolCount.get(id) ?? 0);
      const seed = baseGraph ? autoCollapseDirs(baseGraph, LOD_NODE_BUDGET, cost) : null;
      if (baseGraph) seedDirectoryLod(baseGraph, seed);
      setAdaptiveLod(seed !== null);
    }
  }, [
    allExpanded,
    fileIds,
    baseGraph,
    symbolCount,
    topDirs,
    seedDirectoryLod,
    setDirectoryBootstrap,
    setDirectorySelection,
  ]);

  const handleResult = useCallback(
    (res: AnalyzeResult, s: Stats, m: PackageManifest[], scannedPath = "") => {
      setResult(res);
      setManifests(m);
      setLevel("file");
      setStats(s);
      setProjectPath(scannedPath);
      setExpanded(new Set());
      // LOD: a huge repo (e.g. linux/drivers) would produce 100k cards the renderer
      // can't draw, so seed the collapsed set with a directory depth that keeps the
      // initial scene to ~AUTO_COLLAPSE_MAX_CARDS aggregate cards. The user can expand
      // any aggregate from here. See docs/SCALE-100K.md.
      const seed = autoCollapseDirs(res.graph, AUTO_COLLAPSE_MAX_CARDS);
      // Seed the AUTO collapse layers (bootstrap + camera selection), NOT intent — a load
      // seed is derived safety, not a user action, so the camera may later open it.
      seedDirectoryLod(res.graph, seed);
      // Adaptive LOD only earns its keep when the graph is too big to draw whole
      // (seed !== null). When it already fits, turn the camera-driven cut OFF — otherwise
      // zooming into a small/medium project collapses on-screen directories as "too-small"
      // (they never reach the open-px threshold) and the view shrinks instead of revealing
      // detail. Big repos keep it on so the cut bounds the rendered card count.
      setAdaptiveLod(seed !== null);
      setSelectedId(null);
      setSelectedEdge(null);
      setSearch("");
      setEdgeRouting("curved");
      setCommunityCollapse(false);
      setFocusedIds(null);
      resetFileFilters(res.graph);
    },
    [resetFileFilters, seedDirectoryLod],
  );

  // Switching levels clears any focus/selection (ids differ across projections) and,
  // for the file/symbol levels, sets a sensible expand state.
  const handleLevel = useCallback(
    (next: Level) => {
      setLevel(next);
      setSelectedId(null);
      setFocusedIds(null);
      if (next === "symbol") setExpanded(new Set(fileIds));
      else if (next === "file") setExpanded(new Set());
    },
    [fileIds],
  );

  // Apply a loaded/imported workspace's view state onto the current graph.
  const applyWorkspace = useCallback(
    (s: ExplorerWorkspaceState) => {
      setSelectedId(s.selectedId);
      setExpanded(s.expanded);
      // The workspace persists the effective collapsed set (bare paths). Restore it into
      // the BOOTSTRAP layer (derived/auto, camera-overridable) — not intent — preserving the
      // pre-refactor restore semantics where the camera could still refine the restored cut.
      // C0 keeps the workspace format unchanged; intent persistence arrives with C1a.
      setIntentByMode((prev) => {
        if (!prev.has(DIRECTORY_MODE)) return prev;
        const next = new Map(prev);
        next.delete(DIRECTORY_MODE);
        return next;
      });
      setDirectoryBootstrap(toDirectoryGroupIds(s.collapsedClusters));
      setDirectorySelection(new Set());
      setFocusedIds(s.focusedIds);
      setShowExternal(s.showExternal);
      setSearch(s.search);
      setEnabledEdgeKinds(s.enabledEdgeKinds);
      setEnabledFacets(s.enabledFacets);
      setEnabledFolders(s.enabledFolders);
      setEnabledLanguages(s.enabledLanguages);
      setAlgorithm(s.algorithm);
      setDirection(s.direction);
      setGroupBy(s.groupBy);
      setDensity(s.density);
      setEdgeRouting(s.edgeRouting);
      setCommunityCollapse(s.communityCollapse);
    },
    [setDirectoryBootstrap, setDirectorySelection],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setSelectedEdge(null); // node and edge detail panels are mutually exclusive
      // Ensure the selected symbol's file is expanded so it becomes visible.
      const parent = parentOf.get(id);
      if (parent && parent !== id) {
        setExpanded((prev) => (prev.has(parent) ? prev : new Set(prev).add(parent)));
      }
    },
    [parentOf],
  );

  const handleSelectEdge = useCallback((edge: SceneEdge) => {
    setSelectedEdge(edge);
    setSelectedId(null);
  }, []);

  const handleToggleExpand = useCallback((fileId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  // Manual collapse/drill — the ONLY writer of user collapse INTENT. `clusterId` is the
  // bare box key from the renderer's cluster/aggregate hit (a directory path in Directory
  // mode; a "Community N" / package / facet box key otherwise). Whether we drill or
  // collapse is decided against the EFFECTIVE collapsed set, but we only ever write
  // namespaced intent into the ACTIVE mode's map — so the camera can't clobber this choice
  // (the C0 fix) AND a non-directory click no longer pollutes the directory intent with
  // ids that map to no directory box (the C1a fix).
  const handleToggleCollapse = useCallback(
    (clusterId: string) => {
      const isCollapsed = collapsedClusters.has(clusterId);
      if (groupBy === "directory") {
        editDirectoryIntent((intent) => {
          if (isCollapsed) {
            // Drill in ONE level: open this aggregate but fold its immediate child
            // directories, so the layout grows by a handful of child aggregates instead of
            // the dir's entire subtree (which on a big dir would dump thousands of
            // files+symbols in, time Smart out, and lock the view to grid). Direct files of
            // this dir still render; deeper dirs stay aggregated and can be drilled too.
            // Writing 'closed' intent on the children (not just relying on bootstrap) keeps
            // them folded even if the camera selection would open them — intent wins.
            intent.set(directoryGroupId(clusterId), "open");
            const node = dirNodes.get(clusterId);
            if (node)
              for (const child of node.children) intent.set(directoryGroupId(child.path), "closed");
          } else {
            intent.set(directoryGroupId(clusterId), "closed");
          }
        });
        return;
      }
      // Non-directory modes: resolve the clicked box key → its namespaced group id via the
      // active cut snapshot, then toggle that group's intent in the ACTIVE mode's map. A
      // plain open/close (no child-folding drill — that is directory-tree-specific).
      const snap = cutGrouping?.snapshot;
      if (!snap) return;
      let gid: GroupId | undefined;
      for (let g = 0; g < snap.boxKeyByGroup.length; g++) {
        if (snap.boxKeyByGroup[g] === clusterId) {
          gid = snap.groupIds[g];
          break;
        }
      }
      if (gid === undefined) return;
      editIntent(groupBy, (intent) => intent.set(gid, isCollapsed ? "open" : "closed"));
    },
    [groupBy, collapsedClusters, dirNodes, editDirectoryIntent, editIntent, cutGrouping],
  );

  // The camera's adaptive cut hands up a GroupLodSelection (the set of OPEN namespaced
  // group ids) FOR A SPECIFIC grouping mode. It updates ONLY that mode's selection layer;
  // it never touches intent or bootstrap, so a zoom can refine detail but can't clobber
  // what the user chose — and switching modes keeps each mode's camera state. (C0 was
  // Directory-only; this is the mode-keyed generalization, spec "Phase plan → C1a".)
  const handleCut = useCallback((modeKey: string, selection: Set<GroupId>) => {
    setSelectionByMode((prev) => new Map(prev).set(modeKey, selection));
  }, []);

  const handleToggleEdgeKind = useCallback((kind: ViewEdgeKind) => {
    setEnabledEdgeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  // Generic facet handlers — the ONLY writers of facet selection. One value
  // toggle and one all/none (also used per Node-types layer). Both keep the map
  // sparse ("all except one" stores one value; clearing the last exclusion drops
  // the entry).
  const handleToggleFacetValue = useCallback((key: FacetKey, value: string) => {
    setEnabledFacets((prev) => toggleFacetValue(prev, key, value));
  }, []);

  const handleSetFacetValues = useCallback((key: FacetKey, values: string[], on: boolean) => {
    setEnabledFacets((prev) => setFacetValues(prev, key, values, on));
  }, []);

  const handleToggleFolder = useCallback((name: string) => {
    setEnabledFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleToggleLanguage = useCallback((key: string) => {
    setEnabledLanguages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSetFolders = useCallback(
    (on: boolean) => setEnabledFolders(on ? new Set(folders.map((f) => f.name)) : new Set()),
    [folders],
  );
  const handleSetLanguages = useCallback(
    (on: boolean) => setEnabledLanguages(on ? new Set(languages.map((l) => l.key)) : new Set()),
    [languages],
  );

  const handleResetFilters = useCallback(() => {
    setSearch("");
    setEnabledEdgeKinds(new Set(FILTERABLE_EDGE_KINDS));
    // Empty map ⇒ every facet value (kind/category/env/runtime/role/…) enabled.
    setEnabledFacets(new Map());
    setShowExternal(false);
    // Also drop any impact/focus constraint and selection — Reset means "show all
    // nodes again", and focus (Dependencies/Dependents/…) otherwise persists with no
    // other way to clear it from here.
    setFocusedIds(null);
    setSelectedId(null);
    setSelectedEdge(null);
    resetFileFilters(graph);
  }, [graph, resetFileFilters]);

  if (!result || !graph) {
    return (
      <Box minH="100vh" bg="bg" overflow="auto">
        <UploadDropzone onResult={handleResult} />
      </Box>
    );
  }

  return (
    <Flex direction="column" h="100vh" bg="bg">
      <HStack px="4" py="3" borderBottomWidth="1px" borderColor="border" gap="4" bg="bg.panel">
        <HStack gap="2">
          <Image src="/polygraph-icon.svg" alt="" boxSize="24px" rounded="md" />
          <Heading size="md">PolyGraph</Heading>
        </HStack>
        <HStack gap="2" color="fg.muted" fontSize="sm">
          <Badge variant="subtle">{graph.nodes.length} nodes</Badge>
          <Badge variant="subtle">{graph.edges.length} edges</Badge>
          {stats && <Text>{stats.fileCount} files</Text>}
          {result.errors.length > 0 && (
            <Badge colorPalette="orange" variant="subtle">
              {result.errors.length} parse warnings
            </Badge>
          )}
        </HStack>
        <ThemeToggle ml="auto" />
        <Button
          size="sm"
          variant={adaptiveLod ? "subtle" : "ghost"}
          colorPalette={adaptiveLod ? "teal" : "gray"}
          onClick={() => setAdaptiveLod((v) => !v)}
          title="Adaptive level-of-detail: open directories into detail as you zoom in (experimental)"
        >
          {adaptiveLod ? "Adaptive LOD: on" : "Adaptive LOD: off"}
        </Button>
        <Button
          size="sm"
          variant={showExternal ? "subtle" : "ghost"}
          colorPalette={showExternal ? "purple" : "gray"}
          onClick={() => setShowExternal((v) => !v)}
        >
          {showExternal ? "Externals: on" : "Externals: off"}
        </Button>
        <Button
          size="sm"
          variant={allExpanded ? "subtle" : "ghost"}
          colorPalette={allExpanded ? "blue" : "gray"}
          onClick={handleToggleExpandAll}
        >
          {allExpanded ? "Collapse all" : "Reveal detail"}
        </Button>
        <Button
          size="sm"
          variant={filtersOpen ? "subtle" : "ghost"}
          colorPalette={filtersOpen ? "blue" : "gray"}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          Filters
        </Button>
        <Button
          size="sm"
          variant={settingsOpen ? "subtle" : "ghost"}
          colorPalette={settingsOpen ? "blue" : "gray"}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          Settings
        </Button>
        <Button
          size="sm"
          variant={problemsOpen ? "subtle" : "ghost"}
          colorPalette={problemsOpen ? "orange" : insights.length > 0 ? "orange" : "gray"}
          onClick={() => setProblemsOpen((v) => !v)}
        >
          Problems{insights.length > 0 ? ` (${insights.length})` : ""}
        </Button>
        <Button
          size="sm"
          variant={exportOpen ? "subtle" : "ghost"}
          colorPalette={exportOpen ? "green" : "gray"}
          onClick={() => setExportOpen((v) => !v)}
        >
          Export
        </Button>
        <Button size="sm" variant="outline" onClick={() => setResult(null)}>
          Analyze another
        </Button>
        {focusedIds && (
          <Button
            size="sm"
            variant="subtle"
            colorPalette="yellow"
            ml="auto"
            onClick={() => setFocusedIds(null)}
          >
            Focusing {focusedIds.size} · Clear ✕
          </Button>
        )}
      </HStack>

      <Flex flex="1" minH="0">
        <Sidebar
          search={search}
          onSearch={setSearch}
          queryMode={queryMode}
          onQueryMode={setQueryMode}
          queryError={queryError}
          matchCount={matchedIds?.size}
          builtinSearches={BUILTIN_SEARCHES}
          savedSearches={savedSearches}
          onApplySearch={setSearch}
          onSaveSearch={handleSaveSearch}
          onDeleteSearch={handleDeleteSearch}
          enabledEdgeKinds={enabledEdgeKinds}
          onToggleEdgeKind={handleToggleEdgeKind}
          enabledFacets={enabledFacets}
          filterDimensions={filterDimensions}
          onToggleFacetValue={handleToggleFacetValue}
          onSetFacetValues={handleSetFacetValues}
          onResetFilters={handleResetFilters}
          algorithm={algorithm}
          onAlgorithm={setAlgorithm}
          direction={direction}
          onDirection={setDirection}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          groupByOptions={groupByOptions}
        />
        <Box flex="1" minW="0" position="relative">
          <VelloGraphCanvas
            graph={graph}
            expanded={expanded}
            symbolCount={symbolCount}
            enabledEdgeKinds={enabledEdgeKinds}
            search={search}
            selectedId={selectedId}
            algorithm={algorithm}
            direction={direction}
            groupBy={groupBy}
            density={density}
            showExternal={showExternal}
            enabledFacets={enabledFacets}
            catalog={catalog}
            enabledFolders={enabledFolders}
            enabledLanguages={enabledLanguages}
            collapsedClusters={collapsedClusters}
            communityCollapse={communityCollapse}
            edgeRouting={edgeRouting}
            focusedIds={focusedIds}
            queryIds={queryIds}
            highlightIds={highlightIds}
            projected={projected}
            manifests={manifests}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onToggleCollapse={handleToggleCollapse}
            onSelectEdge={handleSelectEdge}
            minimap={minimap}
            adaptiveLod={adaptiveLod}
            onCut={handleCut}
            onCommunityOf={handleCommunityOf}
            groupingSnapshot={cutGrouping?.snapshot ?? null}
            fitSignature={fitSignature}
          />
        </Box>
        {filtersOpen && (
          <FiltersPanel
            folders={folders}
            languages={languages}
            enabledFolders={enabledFolders}
            enabledLanguages={enabledLanguages}
            onToggleFolder={handleToggleFolder}
            onToggleLanguage={handleToggleLanguage}
            onSetFolders={handleSetFolders}
            onSetLanguages={handleSetLanguages}
            onClose={() => setFiltersOpen(false)}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            level={level}
            onLevel={handleLevel}
            packageCount={manifests.length}
            density={density}
            onDensity={setDensity}
            minimap={minimap}
            onMinimap={setMinimap}
            edgeRouting={edgeRouting}
            onEdgeRouting={setEdgeRouting}
            communityCollapse={communityCollapse}
            onCommunityCollapse={setCommunityCollapse}
            telemetryOn={telemetryOn}
            onTelemetry={handleTelemetry}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {problemsOpen && (
          <ProblemsPanel
            insights={insights}
            onFocus={setFocusedIds}
            onClose={() => setProblemsOpen(false)}
          />
        )}
        {exportOpen && (
          <ExportPanel
            graph={graph}
            insights={insights}
            catalog={catalog}
            queryIds={queryIds}
            projected={projected}
            state={{
              projectPath,
              selectedId,
              expanded,
              collapsedClusters,
              focusedIds,
              showExternal,
              search,
              enabledEdgeKinds,
              enabledFacets,
              enabledFolders,
              enabledLanguages,
              algorithm,
              direction,
              groupBy,
              density,
              edgeRouting,
              communityCollapse,
            }}
            onApplyWorkspace={applyWorkspace}
            onClose={() => setExportOpen(false)}
          />
        )}
        {selectedId && (
          <NodeDetailPanel
            graph={graph}
            selectedId={selectedId}
            projectPath={projectPath}
            onSelect={handleSelect}
            onFocus={setFocusedIds}
            onClose={() => setSelectedId(null)}
          />
        )}
        {selectedEdge && !selectedId && (
          <EdgeDetailPanel
            graph={graph}
            edge={selectedEdge}
            onSelect={handleSelect}
            onClose={() => setSelectedEdge(null)}
          />
        )}
      </Flex>
    </Flex>
  );
}
