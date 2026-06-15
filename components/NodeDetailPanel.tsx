"use client";

import { useMemo } from "react";
import { Badge, Box, CloseButton, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import type { GraphEdge, GraphModel } from "@/lib/graph/types";
import { EDGE_STYLES, NODE_STYLES } from "@/lib/graph/visual";

interface NodeDetailPanelProps {
  graph: GraphModel;
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

interface Related {
  edge: GraphEdge;
  otherId: string;
}

export function NodeDetailPanel({ graph, selectedId, onSelect, onClose }: NodeDetailPanelProps) {
  const node = graph.nodes.find((n) => n.id === selectedId);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const { outgoing, incoming } = useMemo(() => {
    const outgoing: Related[] = [];
    const incoming: Related[] = [];
    for (const edge of graph.edges) {
      if (edge.source === selectedId) outgoing.push({ edge, otherId: edge.target });
      if (edge.target === selectedId) incoming.push({ edge, otherId: edge.source });
    }
    return { outgoing, incoming };
  }, [graph.edges, selectedId]);

  if (!node) return null;
  const style = NODE_STYLES[node.kind];

  const EdgeRow = ({ rel, direction }: { rel: Related; direction: "out" | "in" }) => {
    const other = nodeById.get(rel.otherId);
    const eStyle = EDGE_STYLES[rel.edge.kind];
    return (
      <HStack
        gap="2"
        px="2"
        py="1.5"
        rounded="md"
        _hover={{ bg: "bg.muted" }}
        cursor="pointer"
        onClick={() => onSelect(rel.otherId)}
      >
        <Badge size="sm" colorPalette={eStyle.palette} variant="subtle">
          {direction === "out" ? "→" : "←"} {eStyle.label}
        </Badge>
        <Text fontSize="sm" color="fg" truncate title={other?.label ?? rel.otherId}>
          {other?.label ?? rel.otherId}
        </Text>
      </HStack>
    );
  };

  return (
    <Stack
      w="300px"
      h="full"
      p="4"
      gap="4"
      bg="bg.panel"
      borderLeftWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <HStack justify="space-between" align="start">
        <Stack gap="1">
          <Badge colorPalette={style.palette} variant="surface" w="fit-content">
            {style.label}
          </Badge>
          <Heading size="md" wordBreak="break-word">
            {node.label}
          </Heading>
        </Stack>
        <CloseButton size="sm" onClick={onClose} />
      </HStack>

      <Box>
        <Text fontSize="xs" color="fg.muted">
          File
        </Text>
        <Text fontSize="sm" fontFamily="mono" wordBreak="break-all">
          {node.filePath}
          {node.line > 0 ? `:${node.line}` : ""}
        </Text>
      </Box>

      <Box>
        <Text fontSize="xs" color="fg.muted" mb="1">
          Outgoing ({outgoing.length})
        </Text>
        {outgoing.length === 0 ? (
          <Text fontSize="sm" color="fg.subtle">
            None
          </Text>
        ) : (
          <Stack gap="0">
            {outgoing.map((rel) => (
              <EdgeRow key={rel.edge.id} rel={rel} direction="out" />
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Text fontSize="xs" color="fg.muted" mb="1">
          Incoming ({incoming.length})
        </Text>
        {incoming.length === 0 ? (
          <Text fontSize="sm" color="fg.subtle">
            None
          </Text>
        ) : (
          <Stack gap="0">
            {incoming.map((rel) => (
              <EdgeRow key={rel.edge.id} rel={rel} direction="in" />
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
