"use client";

import { Box, Button, Heading, HStack, Input, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import {
  EDGE_STYLES,
  EXTERNAL_STYLES,
  FILTERABLE_EDGE_KINDS,
  FILTERABLE_NODE_KINDS,
  NODE_STYLES,
  ROLE_STYLES,
} from "@/lib/graph/visual";
import type {
  Environment,
  ExternalKind,
  NodeCategory,
  NodeKind,
  NodeRole,
  Runtime,
} from "@/lib/graph/types";
import { DIRECTIONAL_ALGORITHMS, type LayoutAlgorithm, type LayoutDirection } from "@/lib/layout";

interface SidebarProps {
  search: string;
  onSearch: (value: string) => void;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  onToggleEdgeKind: (kind: ViewEdgeKind) => void;
  enabledNodeKinds: Set<NodeKind>;
  onToggleNodeKind: (kind: NodeKind) => void;
  enabledCategories: Set<NodeCategory>;
  onToggleCategory: (category: NodeCategory) => void;
  enabledEnvironments: Set<Environment>;
  onToggleEnvironment: (env: Environment) => void;
  enabledRuntimes: Set<Runtime>;
  onToggleRuntime: (rt: Runtime) => void;
  onResetFilters: () => void;
  algorithm: LayoutAlgorithm;
  onAlgorithm: (algorithm: LayoutAlgorithm) => void;
  direction: LayoutDirection;
  onDirection: (direction: LayoutDirection) => void;
}

const CATEGORIES: { value: NodeCategory; label: string; color: string }[] = [
  { value: "ui", label: "UI", color: "#22c55e" },
  { value: "feature", label: "Feature", color: "#3b82f6" },
];

const ENVIRONMENTS: { value: Environment; label: string; color: string }[] = [
  { value: "client", label: "Client", color: "#fb923c" },
  { value: "server", label: "Server", color: "#2dd4bf" },
];

const RUNTIMES: { value: Runtime; label: string; color: string }[] = [
  { value: "node", label: "node", color: "#4ade80" },
  { value: "deno", label: "deno", color: "#60a5fa" },
  { value: "bun", label: "bun", color: "#f472b6" },
];

const ALGORITHMS: { value: LayoutAlgorithm; label: string; glyph: string }[] = [
  { value: "layered", label: "Layered", glyph: "▤" },
  { value: "tree", label: "Tree", glyph: "⌄" },
  { value: "radial", label: "Radial", glyph: "◎" },
  { value: "circular", label: "Circular", glyph: "○" },
  { value: "grid", label: "Grid", glyph: "▦" },
  { value: "force", label: "Force", glyph: "✸" },
];

const DIRECTIONS: { value: LayoutDirection; label: string; glyph: string }[] = [
  { value: "TB", label: "Top down", glyph: "↓" },
  { value: "LR", label: "Left → right", glyph: "→" },
  { value: "BT", label: "Bottom up", glyph: "↑" },
  { value: "RL", label: "Right → left", glyph: "←" },
];

function Dot({ color }: { color: string }) {
  return <Box w="10px" h="10px" rounded="full" bg={color} flexShrink={0} />;
}

export function Sidebar({
  search,
  onSearch,
  enabledEdgeKinds,
  onToggleEdgeKind,
  enabledNodeKinds,
  onToggleNodeKind,
  enabledCategories,
  onToggleCategory,
  enabledEnvironments,
  onToggleEnvironment,
  enabledRuntimes,
  onToggleRuntime,
  onResetFilters,
  algorithm,
  onAlgorithm,
  direction,
  onDirection,
}: SidebarProps) {
  const directionEnabled = DIRECTIONAL_ALGORITHMS.includes(algorithm);
  return (
    <Stack
      w="260px"
      h="full"
      p="4"
      gap="6"
      bg="bg.panel"
      borderRightWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <Box>
        <HStack justify="space-between" mb="2">
          <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
            Search
          </Heading>
          <Button size="xs" variant="ghost" colorPalette="gray" onClick={onResetFilters}>
            Reset
          </Button>
        </HStack>
        <Input
          size="sm"
          placeholder="Filter nodes by name…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Layout
        </Heading>
        <SimpleGrid columns={2} gap="1.5">
          {ALGORITHMS.map((a) => {
            const active = algorithm === a.value;
            return (
              <Button
                key={a.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? "blue" : "gray"}
                opacity={active ? 1 : 0.7}
                onClick={() => onAlgorithm(a.value)}
              >
                <Text fontWeight="bold">{a.glyph}</Text>
                <Text ml="1.5" fontSize="xs">
                  {a.label}
                </Text>
              </Button>
            );
          })}
        </SimpleGrid>

        <Text fontSize="xs" color="fg.muted" mt="3" mb="1.5">
          Direction {directionEnabled ? "" : "(layered / tree only)"}
        </Text>
        <SimpleGrid columns={2} gap="1.5">
          {DIRECTIONS.map((d) => {
            const active = direction === d.value;
            return (
              <Button
                key={d.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? "blue" : "gray"}
                opacity={directionEnabled ? (active ? 1 : 0.7) : 0.35}
                disabled={!directionEnabled}
                onClick={() => onDirection(d.value)}
              >
                <Text fontWeight="bold">{d.glyph}</Text>
                <Text ml="1.5" fontSize="xs">
                  {d.label}
                </Text>
              </Button>
            );
          })}
        </SimpleGrid>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Relationships
        </Heading>
        <Stack gap="1.5">
          {FILTERABLE_EDGE_KINDS.map((kind) => {
            const active = enabledEdgeKinds.has(kind);
            const style = EDGE_STYLES[kind];
            return (
              <Button
                key={kind}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? style.palette : "gray"}
                opacity={active ? 1 : 0.55}
                onClick={() => onToggleEdgeKind(kind)}
              >
                <Dot color={style.color} />
                <Text ml="2">{style.label}</Text>
              </Button>
            );
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Category
        </Heading>
        <SimpleGrid columns={2} gap="1.5">
          {CATEGORIES.map((c) => {
            const active = enabledCategories.has(c.value);
            return (
              <Button
                key={c.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? (c.value === "ui" ? "green" : "blue") : "gray"}
                opacity={active ? 1 : 0.55}
                onClick={() => onToggleCategory(c.value)}
              >
                <Dot color={c.color} />
                <Text ml="2">{c.label}</Text>
              </Button>
            );
          })}
        </SimpleGrid>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Environment
        </Heading>
        <SimpleGrid columns={2} gap="1.5">
          {ENVIRONMENTS.map((e) => {
            const active = enabledEnvironments.has(e.value);
            return (
              <Button
                key={e.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? (e.value === "client" ? "orange" : "teal") : "gray"}
                opacity={active ? 1 : 0.55}
                onClick={() => onToggleEnvironment(e.value)}
              >
                <Dot color={e.color} />
                <Text ml="2">{e.label}</Text>
              </Button>
            );
          })}
        </SimpleGrid>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Runtime
        </Heading>
        <Stack gap="1.5">
          {RUNTIMES.map((r) => {
            const active = enabledRuntimes.has(r.value);
            return (
              <Button
                key={r.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? "purple" : "gray"}
                opacity={active ? 1 : 0.55}
                onClick={() => onToggleRuntime(r.value)}
              >
                <Dot color={r.color} />
                <Text ml="2">{r.label}</Text>
              </Button>
            );
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Node types
        </Heading>
        <Stack gap="1.5">
          {FILTERABLE_NODE_KINDS.map((kind) => {
            const active = enabledNodeKinds.has(kind);
            const style = NODE_STYLES[kind];
            return (
              <Button
                key={kind}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? style.palette : "gray"}
                opacity={active ? 1 : 0.55}
                onClick={() => onToggleNodeKind(kind)}
              >
                <Dot color={style.color} />
                <Text ml="2">{style.label}</Text>
              </Button>
            );
          })}
        </Stack>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Detected roles
        </Heading>
        <Stack gap="2">
          {(Object.keys(ROLE_STYLES) as NodeRole[]).map((role) => (
            <HStack key={role} gap="2">
              <Dot color={ROLE_STYLES[role].color} />
              <Text fontSize="sm" color="fg.muted">
                {ROLE_STYLES[role].label}
              </Text>
            </HStack>
          ))}
        </Stack>
      </Box>

      <Box>
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          External sources
        </Heading>
        <Stack gap="2">
          {(Object.keys(EXTERNAL_STYLES) as ExternalKind[]).map((ext) => (
            <HStack key={ext} gap="2">
              <Dot color={EXTERNAL_STYLES[ext].color} />
              <Text fontSize="sm" color="fg.muted">
                {EXTERNAL_STYLES[ext].label}
              </Text>
            </HStack>
          ))}
        </Stack>
      </Box>

      <Text fontSize="xs" color="fg.subtle" mt="auto">
        Toggle “Externals” in the toolbar to show imported packages and Node/Deno/Bun APIs.
      </Text>
    </Stack>
  );
}
