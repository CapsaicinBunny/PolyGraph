"use client";

import { useMemo } from "react";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import type { Insight, InsightKind } from "@/lib/graph/insights";

const KIND_LABEL: Record<InsightKind, string> = {
  cycle: "Circular dependencies",
  "fan-in": "High fan-in",
  "fan-out": "High fan-out",
  bottleneck: "Bottlenecks",
  orphan: "Isolated nodes",
  "client-server": "Client → server violations",
  undeclared: "Undeclared dependencies",
  "deep-chain": "Deep dependency chains",
  instability: "Instability (SDP) violations",
  ambiguous: "Ambiguous resolutions",
  unresolved: "Unresolved imports",
};
// Stable display order.
const ORDER: InsightKind[] = [
  "cycle",
  "client-server",
  "undeclared",
  "unresolved",
  "ambiguous",
  "bottleneck",
  "fan-in",
  "fan-out",
  "instability",
  "deep-chain",
  "orphan",
];

interface ProblemsPanelProps {
  insights: Insight[];
  onFocus: (ids: Set<string>) => void;
  onClose: () => void;
}

export function ProblemsPanel({ insights, onFocus, onClose }: ProblemsPanelProps) {
  const groups = useMemo(() => {
    const byKind = new Map<InsightKind, Insight[]>();
    for (const i of insights) {
      const list = byKind.get(i.kind);
      if (list) list.push(i);
      else byKind.set(i.kind, [i]);
    }
    return ORDER.filter((k) => byKind.has(k)).map((k) => [k, byKind.get(k)!] as const);
  }, [insights]);

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
      <Flex align="center" justify="space-between">
        <Text fontSize="sm" fontWeight="semibold">
          Problems ({insights.length})
        </Text>
        <chakra.button
          type="button"
          aria-label="Close problems"
          onClick={onClose}
          color="fg.muted"
          _hover={{ color: "fg" }}
          fontSize="lg"
          lineHeight="1"
        >
          ✕
        </chakra.button>
      </Flex>

      {insights.length === 0 ? (
        <Text fontSize="sm" color="fg.subtle">
          No issues detected 🎉
        </Text>
      ) : (
        groups.map(([kind, items]) => (
          <Box key={kind}>
            <Text
              fontSize="11px"
              fontWeight="semibold"
              textTransform="uppercase"
              letterSpacing="wider"
              color="fg.muted"
              mb="1.5"
            >
              {KIND_LABEL[kind]} ({items.length})
            </Text>
            <Stack gap="1">
              {items.map((i) => (
                <Box
                  key={i.id}
                  px="2"
                  py="1.5"
                  rounded="md"
                  cursor="pointer"
                  _hover={{ bg: "bg.muted" }}
                  onClick={() => onFocus(new Set(i.nodeIds))}
                  title="Focus this subgraph"
                >
                  <Flex gap="2" align="center">
                    <Box
                      w="2"
                      h="2"
                      rounded="full"
                      flexShrink="0"
                      bg={i.severity === "warning" ? "orange.solid" : "gray.solid"}
                    />
                    <Text fontSize="sm" color="fg" truncate>
                      {i.title}
                    </Text>
                  </Flex>
                  {i.detail && (
                    <Text fontSize="xs" color="fg.subtle" truncate title={i.detail}>
                      {i.detail}
                    </Text>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>
        ))
      )}
    </Stack>
  );
}
