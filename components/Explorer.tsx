"use client";

import { useCallback, useMemo, useState } from "react";
import { Badge, Box, Button, Flex, Heading, HStack, Image, Text } from "@chakra-ui/react";
import dynamic from "next/dynamic";
import type { ViewEdgeKind } from "@/lib/aggregate";
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
import { FiltersPanel } from "./FiltersPanel";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { UploadDropzone } from "./UploadDropzone";

// Vello renders via WebGPU (browser-only), so load it client-side.
const VelloGraphCanvas = dynamic(
  () => import("./VelloGraphCanvas").then((m) => m.VelloGraphCanvas),
  { ssr: false },
);

const ALL_ENVIRONMENTS: Environment[] = ["client", "server"];
const ALL_RUNTIMES: Runtime[] = ["node", "deno", "bun"];
const ALL_CATEGORIES: NodeCategory[] = ["ui", "feature"];

interface Stats {
  fileCount: number;
  skipped: number;
}

export function Explorer() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [algorithm, setAlgorithm] = useState<LayoutAlgorithm>("layered");
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [groupBy, setGroupBy] = useState<GroupBy>("directory");
  const [density, setDensity] = useState(1);
  const [showExternal, setShowExternal] = useState(false);
  const [enabledFolders, setEnabledFolders] = useState<Set<string>>(() => new Set());
  const [enabledLanguages, setEnabledLanguages] = useState<Set<string>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [edgeRouting, setEdgeRouting] = useState<"curved" | "orthogonal">("curved");
  const [communityCollapse, setCommunityCollapse] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const graph = result?.graph ?? null;

  const folders = useMemo(() => (graph ? availableFolders(graph) : []), [graph]);
  const languages = useMemo(() => (graph ? availableLanguages(graph) : []), [graph]);

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

  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graph?.nodes ?? []) map.set(n.id, n.parentFile);
    return map;
  }, [graph]);

  const fileIds = useMemo(
    () => (graph?.nodes ?? []).filter((n) => n.kind === "file").map((n) => n.id),
    [graph],
  );
  const allExpanded = fileIds.length > 0 && fileIds.every((id) => expanded.has(id));

  const handleToggleExpandAll = useCallback(() => {
    setExpanded(allExpanded ? new Set() : new Set(fileIds));
  }, [allExpanded, fileIds]);

  const handleResult = useCallback(
    (res: AnalyzeResult, s: Stats) => {
      setResult(res);
      setStats(s);
      setExpanded(new Set());
      setCollapsedClusters(new Set());
      setSelectedId(null);
      setSearch("");
      setEdgeRouting("curved");
      setCommunityCollapse(false);
      resetFileFilters(res.graph);
    },
    [resetFileFilters],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      // Ensure the selected symbol's file is expanded so it becomes visible.
      const parent = parentOf.get(id);
      if (parent && parent !== id) {
        setExpanded((prev) => (prev.has(parent) ? prev : new Set(prev).add(parent)));
      }
    },
    [parentOf],
  );

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
        <Button size="sm" variant="outline" onClick={() => setResult(null)}>
          Analyze another
        </Button>
      </HStack>

      <Flex flex="1" minH="0">
        <Sidebar
          search={search}
          onSearch={setSearch}
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
          onResetFilters={handleResetFilters}
          algorithm={algorithm}
          onAlgorithm={setAlgorithm}
          direction={direction}
          onDirection={setDirection}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          density={density}
          onDensity={setDensity}
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
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onToggleCollapse={handleToggleCollapse}
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
            edgeRouting={edgeRouting}
            onEdgeRouting={setEdgeRouting}
            communityCollapse={communityCollapse}
            onCommunityCollapse={setCommunityCollapse}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {selectedId && (
          <NodeDetailPanel
            graph={graph}
            selectedId={selectedId}
            onSelect={handleSelect}
            onClose={() => setSelectedId(null)}
          />
        )}
      </Flex>
    </Flex>
  );
}
