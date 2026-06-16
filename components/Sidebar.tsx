"use client";

import { Box, Button, Heading, HStack, Input, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { EDGE_STYLES, FILTERABLE_EDGE_KINDS, NODE_STYLES, ROLE_STYLES } from "@/lib/graph/visual";
import type { NodeKind, NodeRole } from "@/lib/graph/types";
import type { LayoutDirection } from "@/lib/layout";

interface SidebarProps {
  search: string;
  onSearch: (value: string) => void;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  onToggleEdgeKind: (kind: ViewEdgeKind) => void;
  direction: LayoutDirection;
  onDirection: (direction: LayoutDirection) => void;
}

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
  direction,
  onDirection,
}: SidebarProps) {
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
        <Heading size="xs" color="fg.muted" mb="2" textTransform="uppercase" letterSpacing="wide">
          Search
        </Heading>
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
          {DIRECTIONS.map((d) => {
            const active = direction === d.value;
            return (
              <Button
                key={d.value}
                size="sm"
                justifyContent="flex-start"
                variant={active ? "subtle" : "ghost"}
                colorPalette={active ? "blue" : "gray"}
                opacity={active ? 1 : 0.7}
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
          Node types
        </Heading>
        <Stack gap="2">
          {(Object.keys(NODE_STYLES) as NodeKind[]).map((kind) => (
            <HStack key={kind} gap="2">
              <Dot color={NODE_STYLES[kind].color} />
              <Text fontSize="sm" color="fg.muted">
                {NODE_STYLES[kind].label}
              </Text>
            </HStack>
          ))}
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

      <Text fontSize="xs" color="fg.subtle" mt="auto">
        Click a file node to expand its classes, functions, and components.
      </Text>
    </Stack>
  );
}
