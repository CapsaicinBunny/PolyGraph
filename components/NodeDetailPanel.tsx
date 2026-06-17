"use client";

import { useMemo, useState } from "react";
import { Badge, Box, Button, CloseButton, Heading, HStack, Stack, Text } from "@chakra-ui/react";
import {
  type BlastRadius,
  blastRadius,
  dependencies,
  dependents,
  neighborhood,
} from "@/lib/graph/query";
import type { GraphEdge, GraphModel } from "@/lib/graph/types";
import { EDGE_STYLES, EXTERNAL_STYLES, NODE_STYLES, ROLE_STYLES } from "@/lib/graph/visual";

interface NodeDetailPanelProps {
  graph: GraphModel;
  selectedId: string;
  onSelect: (id: string) => void;
  onFocus: (ids: Set<string>) => void;
  onClose: () => void;
}

interface Related {
  edge: GraphEdge;
  otherId: string;
}

export function NodeDetailPanel({
  graph,
  selectedId,
  onSelect,
  onFocus,
  onClose,
}: NodeDetailPanelProps) {
  const node = graph.nodes.find((n) => n.id === selectedId);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const [depth, setDepth] = useState(2);
  // Tag the on-demand blast-radius readout with the node it was computed for, so it
  // doesn't linger when the selection changes.
  const [blast, setBlast] = useState<{ id: string; data: BlastRadius } | null>(null);
  const blastData = blast?.id === selectedId ? blast.data : null;

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
  const kindStyle = NODE_STYLES[node.kind];

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
          <HStack gap="1">
            <Badge colorPalette={kindStyle.palette} variant="surface" w="fit-content">
              {kindStyle.label}
            </Badge>
            {node.role && (
              <Badge colorPalette={ROLE_STYLES[node.role].palette} variant="solid" w="fit-content">
                {ROLE_STYLES[node.role].label}
              </Badge>
            )}
            {node.externalKind && (
              <Badge
                colorPalette={EXTERNAL_STYLES[node.externalKind].palette}
                variant="solid"
                w="fit-content"
              >
                {EXTERNAL_STYLES[node.externalKind].label}
              </Badge>
            )}
          </HStack>
          <Heading size="md" wordBreak="break-word">
            {node.label}
          </Heading>
        </Stack>
        <CloseButton size="sm" onClick={onClose} />
      </HStack>

      <Box>
        <Text fontSize="xs" color="fg.muted" mb="1.5">
          Impact / focus
        </Text>
        <HStack gap="1.5" wrap="wrap">
          <Button
            size="xs"
            variant="subtle"
            onClick={() => onFocus(new Set([selectedId, ...dependencies(graph, selectedId)]))}
          >
            Dependencies
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => onFocus(new Set([selectedId, ...dependents(graph, selectedId)]))}
          >
            Dependents
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => onFocus(neighborhood(graph, selectedId, depth))}
          >
            Neighborhood
          </Button>
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setBlast({ id: selectedId, data: blastRadius(graph, selectedId) })}
          >
            Blast radius
          </Button>
        </HStack>
        <HStack gap="1" mt="2" align="center">
          <Text fontSize="xs" color="fg.muted">
            Depth
          </Text>
          {[1, 2, 3, 4, 5].map((d) => (
            <Button
              key={d}
              size="xs"
              variant={depth === d ? "solid" : "ghost"}
              colorPalette={depth === d ? "blue" : "gray"}
              onClick={() => setDepth(d)}
            >
              {d}
            </Button>
          ))}
        </HStack>
        {blastData && (
          <Box mt="2" fontSize="xs" color="fg.muted">
            <Text>
              Blast radius: <b>{blastData.total}</b> affected node{blastData.total === 1 ? "" : "s"}
            </Text>
            <Text>
              By package:{" "}
              {Object.entries(blastData.byPackage)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([k, v]) => `${k} (${v})`)
                .join(", ") || "—"}
            </Text>
            <Text>
              By relationship:{" "}
              {Object.entries(blastData.byKind)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k} (${v})`)
                .join(", ") || "—"}
            </Text>
          </Box>
        )}
      </Box>

      {node.kind === "external" ? (
        <Box>
          <Text fontSize="xs" color="fg.muted" mb="1.5">
            External dependency
          </Text>
          {node.externalKind === "npm" && (
            <HStack gap="1.5" wrap="wrap" mb="2">
              {node.dependencyType && (
                <Badge
                  colorPalette={node.dependencyType === "undeclared" ? "red" : "purple"}
                  variant="subtle"
                >
                  {node.dependencyType}
                </Badge>
              )}
              {node.version && (
                <Badge colorPalette="gray" variant="subtle" fontFamily="mono">
                  {node.version}
                </Badge>
              )}
            </HStack>
          )}
          <Text fontSize="sm" color="fg.muted">
            Out of the analyzed project. Edges below show where it’s used.
          </Text>
        </Box>
      ) : (
        <>
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
            <Text fontSize="xs" color="fg.muted" mb="1.5">
              About
            </Text>
            <HStack gap="1.5" wrap="wrap">
              {node.category && (
                <Badge colorPalette={node.category === "ui" ? "green" : "blue"} variant="subtle">
                  {node.category === "ui" ? "UI" : "Feature"}
                </Badge>
              )}
              {node.environment ? (
                <Badge
                  colorPalette={node.environment === "client" ? "orange" : "teal"}
                  variant="subtle"
                >
                  {node.environment === "client" ? "Client" : "Server"}
                </Badge>
              ) : (
                <Badge
                  colorPalette="gray"
                  variant="subtle"
                  title="No use client/use server directive"
                >
                  Env: unspecified
                </Badge>
              )}
              {node.runtimes?.length ? (
                node.runtimes.map((rt) => (
                  <Badge key={rt} colorPalette="purple" variant="subtle">
                    {rt}
                  </Badge>
                ))
              ) : (
                <Badge colorPalette="gray" variant="subtle">
                  runtime: agnostic
                </Badge>
              )}
            </HStack>
          </Box>
        </>
      )}

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
