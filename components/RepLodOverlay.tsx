"use client";

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import type { RepLodOverlayStats } from "@/lib/graph/lod-observability";

/**
 * Dev overlay for the representation-LOD cut (Appendix A §I). Renders the committed-cut
 * stats the solver/runtime expose so the projectedError priority can be tuned by
 * observation rather than guesswork: generation, pending/committed reps, nodes/edges/
 * labels vs budget, GPU MB, layout-work %, refinements/evictions, proxy cache hit, cut-
 * solve ms, scene-rebuild ms, and the per-rep why-not-refined breakdown.
 *
 * Pure presentational; shown only when representation LOD is on and stats exist.
 */
export function RepLodOverlay({ stats }: { stats: RepLodOverlayStats }) {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const vsBudget = (cur: number, target: number, hard?: number) =>
    `${cur}${target ? ` / ${target}` : ""}${hard ? ` (hard ${hard})` : ""}`;

  return (
    <Box
      position="absolute"
      top="3"
      right="3"
      zIndex={6}
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border"
      rounded="md"
      shadow="md"
      px="3"
      py="2"
      fontSize="xs"
      fontFamily="mono"
      maxW="260px"
      pointerEvents="none"
      opacity={0.95}
    >
      <Text fontWeight="bold" mb="1" color="teal.fg">
        Representation LOD
      </Text>
      <VStack align="stretch" gap="0.5">
        <Row label="generation" value={String(stats.generation)} />
        <Row label="reps (pend/commit)" value={`${stats.pendingReps} / ${stats.committedReps}`} />
        <Row label="nodes" value={vsBudget(stats.nodes, stats.targetNodes, stats.hardNodes)} />
        <Row label="edges" value={vsBudget(stats.edges, stats.targetEdges)} />
        <Row label="labels" value={vsBudget(stats.labels, stats.targetLabels)} />
        <Row label="GPU MB" value={stats.gpuMB.toFixed(2)} />
        <Row label="layout-work" value={pct(stats.layoutWorkPct)} />
        <Row label="refine/evict" value={`${stats.refinements} / ${stats.evictions}`} />
        <Row label="proxy cache hit" value={pct(stats.proxyCacheHitRate)} />
        <Row label="cut-solve ms" value={stats.cutSolveMs.toFixed(2)} />
        <Row label="scene-rebuild ms" value={stats.sceneRebuildMs.toFixed(2)} />
        {stats.whyNotRefined.length > 0 && (
          <Box mt="1" pt="1" borderTopWidth="1px" borderColor="border">
            <Text color="fg.muted" mb="0.5">
              why-not-refined
            </Text>
            {stats.whyNotRefined.map((row) => (
              <Row key={row.reason} label={row.reason} value={String(row.count)} muted />
            ))}
          </Box>
        )}
      </VStack>
    </Box>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <HStack justify="space-between" gap="3">
      <Text color={muted ? "fg.muted" : "fg"}>{label}</Text>
      <Text color={muted ? "fg.muted" : "fg"}>{value}</Text>
    </HStack>
  );
}
