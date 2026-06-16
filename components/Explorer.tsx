"use client";

import { useCallback, useMemo, useState } from "react";
import { Badge, Box, Button, Flex, Heading, HStack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import type { AnalyzeResult } from "@/lib/graph/types";
import { FILTERABLE_EDGE_KINDS } from "@/lib/graph/visual";
import type { LayoutDirection } from "@/lib/layout";
import { GraphCanvas } from "./GraphCanvas";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { Sidebar } from "./Sidebar";
import { UploadDropzone } from "./UploadDropzone";

interface Stats {
  fileCount: number;
  skipped: number;
}

export function Explorer() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [enabledEdgeKinds, setEnabledEdgeKinds] = useState<Set<ViewEdgeKind>>(
    () => new Set(FILTERABLE_EDGE_KINDS),
  );
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [direction, setDirection] = useState<LayoutDirection>("LR");

  const graph = result?.graph ?? null;

  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of graph?.nodes ?? []) map.set(n.id, n.parentFile);
    return map;
  }, [graph]);

  const handleResult = useCallback((res: AnalyzeResult, s: Stats) => {
    setResult(res);
    setStats(s);
    setExpanded(new Set());
    setSelectedId(null);
    setSearch("");
  }, []);

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

  const handleToggleEdgeKind = useCallback((kind: ViewEdgeKind) => {
    setEnabledEdgeKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  if (!result || !graph) {
    return (
      <Box h="100vh" bg="bg" overflow="auto">
        <Box pt="16" textAlign="center">
          <Heading size="2xl">TS Module Scanner</Heading>
          <Text color="fg.muted" mt="2">
            Visualize modules, classes, functions, components, and what calls what.
          </Text>
        </Box>
        <UploadDropzone onResult={handleResult} />
      </Box>
    );
  }

  return (
    <Flex direction="column" h="100vh" bg="bg">
      <HStack px="4" py="3" borderBottomWidth="1px" borderColor="border" gap="4" bg="bg.panel">
        <Heading size="md">TS Module Scanner</Heading>
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
        <Button ml="auto" size="sm" variant="outline" onClick={() => setResult(null)}>
          Analyze another
        </Button>
      </HStack>

      <Flex flex="1" minH="0">
        <Sidebar
          search={search}
          onSearch={setSearch}
          enabledEdgeKinds={enabledEdgeKinds}
          onToggleEdgeKind={handleToggleEdgeKind}
          direction={direction}
          onDirection={setDirection}
        />
        <Box flex="1" minW="0" position="relative">
          <GraphCanvas
            graph={graph}
            expanded={expanded}
            enabledEdgeKinds={enabledEdgeKinds}
            search={search}
            selectedId={selectedId}
            direction={direction}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
          />
        </Box>
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
