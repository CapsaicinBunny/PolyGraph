"use client";

import { useMemo, useState } from "react";
import { Badge, Box, chakra, CloseButton, HStack, Stack, Text } from "@chakra-ui/react";
import type { SceneEdge } from "@/lib/graph/scene";
import type { EdgeConfidence, GraphModel } from "@/lib/graph/types";
import { EDGE_STYLES } from "@/lib/graph/visual";

interface EdgeDetailPanelProps {
  graph: GraphModel;
  edge: SceneEdge;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const CONFIDENCE_PALETTE: Record<EdgeConfidence, string> = {
  exact: "green",
  inferred: "blue",
  ambiguous: "orange",
};

// Most underlying relationships we list before truncating (very dense collapsed
// edges can merge hundreds; the count in the header still reflects the true total).
const MAX_RELATIONSHIPS = 50;

/** Parse a `${source}->${target}:${kind}` edge id back into its endpoints. */
function parseEdgeId(id: string): { source: string; target: string } | null {
  const arrow = id.indexOf("->");
  if (arrow < 0) return null;
  const source = id.slice(0, arrow);
  const rest = id.slice(arrow + 2);
  const colon = rest.lastIndexOf(":");
  return { source, target: colon >= 0 ? rest.slice(0, colon) : rest };
}

export function EdgeDetailPanel({ graph, edge, onSelect, onClose }: EdgeDetailPanelProps) {
  const [showRelationships, setShowRelationships] = useState(false);
  const labelOf = useMemo(() => {
    const m = new Map(graph.nodes.map((n) => [n.id, n.label]));
    return (id: string) => m.get(id) ?? id;
  }, [graph.nodes]);

  const eStyle = EDGE_STYLES[edge.kind as keyof typeof EDGE_STYLES];
  const providers = [...new Set(edge.occurrences.map((o) => o.provider))];
  const confidences = [...new Set(edge.occurrences.map((o) => o.confidence))] as EdgeConfidence[];

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
        <HStack gap="1.5">
          <Badge colorPalette={eStyle?.palette ?? "gray"} variant="surface">
            {eStyle?.label ?? edge.kind}
          </Badge>
        </HStack>
        <CloseButton size="sm" onClick={onClose} />
      </HStack>

      <Stack gap="1">
        <Text
          fontSize="sm"
          fontWeight="medium"
          cursor="pointer"
          _hover={{ textDecoration: "underline" }}
          onClick={() => onSelect(edge.source)}
          truncate
        >
          {labelOf(edge.source)}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          {eStyle?.label ?? edge.kind} ↓
        </Text>
        <Text
          fontSize="sm"
          fontWeight="medium"
          cursor="pointer"
          _hover={{ textDecoration: "underline" }}
          onClick={() => onSelect(edge.target)}
          truncate
        >
          {labelOf(edge.target)}
        </Text>
      </Stack>

      <Box>
        <HStack gap="1.5" mb="1">
          <Text fontSize="xs" color="fg.muted">
            Resolution
          </Text>
          {confidences.map((c) => (
            <Badge key={c} size="sm" colorPalette={CONFIDENCE_PALETTE[c]} variant="subtle">
              {c}
            </Badge>
          ))}
          {providers.length > 0 && (
            <Text fontSize="xs" color="fg.subtle">
              · {providers.join(", ")}
            </Text>
          )}
        </HStack>
      </Box>

      <Box>
        <Text fontSize="xs" color="fg.muted" mb="1.5">
          {edge.count} occurrence{edge.count === 1 ? "" : "s"}
          {edge.count > edge.occurrences.length ? ` (showing ${edge.occurrences.length})` : ""}
        </Text>
        {edge.occurrences.length === 0 ? (
          <Text fontSize="sm" color="fg.subtle">
            No location evidence captured for this provider yet.
          </Text>
        ) : (
          <Stack gap="0.5">
            {edge.occurrences.map((o, i) => (
              <HStack key={`${o.filePath}:${o.line}:${o.column ?? ""}:${i}`} gap="2" fontSize="xs">
                <Text fontFamily="mono" color="fg" truncate title={`${o.filePath}:${o.line}`}>
                  {o.filePath}:{o.line}
                  {o.column ? `:${o.column}` : ""}
                </Text>
                <Badge
                  size="xs"
                  colorPalette={CONFIDENCE_PALETTE[o.confidence]}
                  variant="subtle"
                  flexShrink="0"
                >
                  {o.confidence}
                </Badge>
              </HStack>
            ))}
          </Stack>
        )}
      </Box>

      {edge.originalEdgeIds.length > 1 && (
        <Box>
          <chakra.button
            type="button"
            onClick={() => setShowRelationships((s) => !s)}
            fontSize="xs"
            color="fg.muted"
            _hover={{ color: "fg" }}
            display="flex"
            alignItems="center"
            gap="1"
          >
            <Box as="span" fontSize="9px">
              {showRelationships ? "▾" : "▸"}
            </Box>
            Underlying relationships ({edge.originalEdgeIds.length})
          </chakra.button>
          {showRelationships && (
            <Stack gap="0.5" mt="1.5">
              {edge.originalEdgeIds.slice(0, MAX_RELATIONSHIPS).map((id) => {
                const parsed = parseEdgeId(id);
                if (!parsed) return null;
                const text = `${labelOf(parsed.source)} → ${labelOf(parsed.target)}`;
                return (
                  <Text
                    key={id}
                    fontSize="xs"
                    fontFamily="mono"
                    color="fg"
                    truncate
                    cursor="pointer"
                    _hover={{ textDecoration: "underline" }}
                    onClick={() => onSelect(parsed.source)}
                    title={text}
                  >
                    {text}
                  </Text>
                );
              })}
              {edge.originalEdgeIds.length > MAX_RELATIONSHIPS && (
                <Text fontSize="xs" color="fg.subtle">
                  +{edge.originalEdgeIds.length - MAX_RELATIONSHIPS} more
                </Text>
              )}
            </Stack>
          )}
        </Box>
      )}
    </Stack>
  );
}
