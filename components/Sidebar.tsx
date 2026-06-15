"use client";

import { Box, Button, Heading, HStack, Input, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import { EDGE_STYLES, FILTERABLE_EDGE_KINDS, NODE_STYLES } from "@/lib/graph/visual";
import type { NodeKind } from "@/lib/graph/types";

interface SidebarProps {
  search: string;
  onSearch: (value: string) => void;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  onToggleEdgeKind: (kind: ViewEdgeKind) => void;
}

function Dot({ color }: { color: string }) {
  return <Box w="10px" h="10px" rounded="full" bg={color} flexShrink={0} />;
}

export function Sidebar({ search, onSearch, enabledEdgeKinds, onToggleEdgeKind }: SidebarProps) {
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

      <Text fontSize="xs" color="fg.subtle" mt="auto">
        Click a file node to expand its classes, functions, and components.
      </Text>
    </Stack>
  );
}
