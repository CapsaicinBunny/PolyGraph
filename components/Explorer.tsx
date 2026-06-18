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
import type {
  AnalyzeResult,
  Environment,
  NodeCategory,
  NodeKind,
  Runtime,
} from "@/lib/graph/types";
import { FILTERABLE_EDGE_KINDS, FILTERABLE_NODE_KINDS } from "@/lib/graph/visual";
import type { GroupBy, LayoutAlgorithm, LayoutDirection } from "@/lib/layout";
import {
  availableFolders,
  availableLanguages,
  DEFAULT_HIDDEN_LANGUAGES,
} from "@/lib/graph/filters";
import { autoCollapseDirs } from "@/lib/graph/auto-collapse";
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

// Vello renders via WebGPU (browser-only), so load it client-side.
const VelloGraphCanvas = dynamic(
  () => import("./VelloGraphCanvas").then((m) => m.VelloGraphCanvas),
  { ssr: false },
);

const ALL_ENVIRONMENTS: Environment[] = ["client", "server"];
const ALL_RUNTIMES: Runtime[] = ["node", "deno", "bun"];
const ALL_CATEGORIES: NodeCategory[] = ["ui", "feature"];
// Above this many file nodes, auto-collapse directories so the initial scene the
// renderer receives stays drawable (LOD v0; see docs/SCALE-100K.md).
const AUTO_COLLAPSE_MAX_CARDS = 2000;

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
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [enabledEdgeKinds, setEnabledEdgeKinds] = useState<Set<ViewEdgeKind>>(
    () => new Set(FILTERABLE_EDGE_KINDS),
  );
  const [enabledNodeKinds, setEnabledNodeKinds] = useState<Set<NodeKind>>(
    () => new Set(FILTERABLE_NODE_KINDS),
  );
  const [enabledCategories, setEnabledCategories] = useState<Set<NodeCategory>>(
    () => new Set(ALL_CATEGORIES),
  );
  const [enabledEnvironments, setEnabledEnvironments] = useState<Set<Environment>>(
    () => new Set(ALL_ENVIRONMENTS),
  );
  const [enabledRuntimes, setEnabledRuntimes] = useState<Set<Runtime>>(() => new Set(ALL_RUNTIMES));
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

  const baseGraph = result?.graph ?? null;

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

  // Which scope attributes actually occur in this codebase. The Category /
  // Environment / Runtime filters are JS/TS heuristics (e.g. "use client",
  // node/deno/bun APIs); on a C/Rust project none of them appear, so we derive
  // the present sets here and let the Sidebar hide empty groups and the whole
  // Scope section rather than offering filters that match nothing.
  const presentScope = useMemo(() => {
    const categories = new Set<NodeCategory>();
    const environments = new Set<Environment>();
    const runtimes = new Set<Runtime>();
    for (const n of baseGraph?.nodes ?? []) {
      if (n.category) categories.add(n.category);
      if (n.environment) environments.add(n.environment);
      if (n.runtimes) for (const rt of n.runtimes) runtimes.add(rt);
    }
    return { categories, environments, runtimes };
  }, [baseGraph]);
  const insights = useMemo(
    () =>
      graph ? [...analyzeInsights(graph), ...unresolvedToInsights(result?.unresolved ?? [])] : [],
    [graph, result],
  );

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
  // user's zoom. Undefined when adaptive LOD is off (renderer then always fits).
  const fitSignature = useMemo(() => {
    if (!adaptiveLod || !graph) return undefined;
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
      set(enabledNodeKinds as Set<string>),
      set(enabledCategories as Set<string>),
      set(enabledEnvironments as Set<string>),
      set(enabledRuntimes as Set<string>),
      set(enabledFolders),
      set(enabledLanguages),
      set(expanded),
      focusedIds ? set(focusedIds) : "",
      queryIds ? set(queryIds) : "",
    ].join("|");
  }, [
    adaptiveLod,
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
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
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

  const fileIds = useMemo(
    () => (baseGraph?.nodes ?? []).filter((n) => n.kind === "file").map((n) => n.id),
    [baseGraph],
  );
  const allExpanded = fileIds.length > 0 && fileIds.every((id) => expanded.has(id));

  const handleToggleExpandAll = useCallback(() => {
    setExpanded(allExpanded ? new Set() : new Set(fileIds));
    // Reseed the collapsed-cluster cut the way a fresh scan does. Without this, a
    // stale cut (e.g. the coarse one the adaptive-LOD pass writes while everything is
    // expanded) lingers after collapsing and most nodes stay folded until a rescan.
    setCollapsedClusters(
      baseGraph
        ? (autoCollapseDirs(baseGraph, AUTO_COLLAPSE_MAX_CARDS)?.collapsed ?? new Set())
        : new Set(),
    );
  }, [allExpanded, fileIds, baseGraph]);

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
      setCollapsedClusters(
        autoCollapseDirs(res.graph, AUTO_COLLAPSE_MAX_CARDS)?.collapsed ?? new Set(),
      );
      setSelectedId(null);
      setSelectedEdge(null);
      setSearch("");
      setEdgeRouting("curved");
      setCommunityCollapse(false);
      setFocusedIds(null);
      resetFileFilters(res.graph);
    },
    [resetFileFilters],
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
  const applyWorkspace = useCallback((s: ExplorerWorkspaceState) => {
    setSelectedId(s.selectedId);
    setExpanded(s.expanded);
    setCollapsedClusters(s.collapsedClusters);
    setFocusedIds(s.focusedIds);
    setShowExternal(s.showExternal);
    setSearch(s.search);
    setEnabledEdgeKinds(s.enabledEdgeKinds);
    setEnabledNodeKinds(s.enabledNodeKinds);
    setEnabledCategories(s.enabledCategories);
    setEnabledEnvironments(s.enabledEnvironments);
    setEnabledRuntimes(s.enabledRuntimes);
    setEnabledFolders(s.enabledFolders);
    setEnabledLanguages(s.enabledLanguages);
    setAlgorithm(s.algorithm);
    setDirection(s.direction);
    setGroupBy(s.groupBy);
    setDensity(s.density);
    setEdgeRouting(s.edgeRouting);
    setCommunityCollapse(s.communityCollapse);
  }, []);

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

  const handleToggleCollapse = useCallback((clusterId: string) => {
    setCollapsedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  const handleToggleEdgeKind = useCallback((kind: ViewEdgeKind) => {
    setEnabledEdgeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const handleToggleNodeKind = useCallback((kind: NodeKind) => {
    setEnabledNodeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const handleSetNodeKinds = useCallback((kinds: NodeKind[], on: boolean) => {
    setEnabledNodeKinds((prev) => {
      const next = new Set(prev);
      for (const kind of kinds) {
        if (on) next.add(kind);
        else next.delete(kind);
      }
      return next;
    });
  }, []);

  const handleToggleCategory = useCallback((category: NodeCategory) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const handleToggleEnvironment = useCallback((env: Environment) => {
    setEnabledEnvironments((prev) => {
      const next = new Set(prev);
      if (next.has(env)) next.delete(env);
      else next.add(env);
      return next;
    });
  }, []);

  const handleToggleRuntime = useCallback((rt: Runtime) => {
    setEnabledRuntimes((prev) => {
      const next = new Set(prev);
      if (next.has(rt)) next.delete(rt);
      else next.add(rt);
      return next;
    });
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
    setEnabledNodeKinds(new Set(FILTERABLE_NODE_KINDS));
    setEnabledCategories(new Set(ALL_CATEGORIES));
    setEnabledEnvironments(new Set(ALL_ENVIRONMENTS));
    setEnabledRuntimes(new Set(ALL_RUNTIMES));
    setShowExternal(false);
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
        <Button size="sm" variant="subtle" onClick={handleToggleExpandAll}>
          {allExpanded ? "Collapse all" : "Expand all"}
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
          enabledNodeKinds={enabledNodeKinds}
          onToggleNodeKind={handleToggleNodeKind}
          onSetNodeKinds={handleSetNodeKinds}
          enabledCategories={enabledCategories}
          onToggleCategory={handleToggleCategory}
          enabledEnvironments={enabledEnvironments}
          onToggleEnvironment={handleToggleEnvironment}
          enabledRuntimes={enabledRuntimes}
          onToggleRuntime={handleToggleRuntime}
          presentCategories={presentScope.categories}
          presentEnvironments={presentScope.environments}
          presentRuntimes={presentScope.runtimes}
          onResetFilters={handleResetFilters}
          algorithm={algorithm}
          onAlgorithm={setAlgorithm}
          direction={direction}
          onDirection={setDirection}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
        />
        <Box flex="1" minW="0" position="relative">
          <VelloGraphCanvas
            graph={graph}
            expanded={expanded}
            enabledEdgeKinds={enabledEdgeKinds}
            search={search}
            selectedId={selectedId}
            algorithm={algorithm}
            direction={direction}
            groupBy={groupBy}
            density={density}
            showExternal={showExternal}
            enabledNodeKinds={enabledNodeKinds}
            enabledCategories={enabledCategories}
            enabledEnvironments={enabledEnvironments}
            enabledRuntimes={enabledRuntimes}
            enabledFolders={enabledFolders}
            enabledLanguages={enabledLanguages}
            collapsedClusters={collapsedClusters}
            communityCollapse={communityCollapse}
            edgeRouting={edgeRouting}
            focusedIds={focusedIds}
            queryIds={queryIds}
            highlightIds={highlightIds}
            projected={projected}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onToggleCollapse={handleToggleCollapse}
            onSelectEdge={handleSelectEdge}
            adaptiveLod={adaptiveLod}
            onCut={setCollapsedClusters}
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
            adaptiveLod={adaptiveLod}
            onAdaptiveLod={setAdaptiveLod}
            edgeRouting={edgeRouting}
            onEdgeRouting={setEdgeRouting}
            communityCollapse={communityCollapse}
            onCommunityCollapse={setCommunityCollapse}
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
            state={{
              projectPath,
              selectedId,
              expanded,
              collapsedClusters,
              focusedIds,
              showExternal,
              search,
              enabledEdgeKinds,
              enabledNodeKinds,
              enabledCategories,
              enabledEnvironments,
              enabledRuntimes,
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
