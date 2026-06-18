"use client";

import { Box, Button, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { type Level, LEVELS } from "@/lib/graph/levels/types";

const LEVEL_LABEL: Record<Level, string> = {
  workspace: "Workspace",
  package: "Package",
  directory: "Directory",
  file: "File",
  symbol: "Symbol",
};

const DENSITIES: { value: number; label: string }[] = [
  { value: 1.6, label: "Sparse" },
  { value: 1.0, label: "Normal" },
  { value: 0.6, label: "Dense" },
];

interface SettingsPanelProps {
  level: Level;
  onLevel: (v: Level) => void;
  packageCount: number;
  density: number;
  onDensity: (v: number) => void;
  edgeRouting: "curved" | "orthogonal";
  onEdgeRouting: (v: "curved" | "orthogonal") => void;
  communityCollapse: boolean;
  onCommunityCollapse: (v: boolean) => void;
  onClose: () => void;
}

function GroupLabel({ title }: { title: string }) {
  return (
    <Text
      fontSize="11px"
      fontWeight="semibold"
      textTransform="uppercase"
      letterSpacing="wider"
      color="fg.muted"
      mb="2"
    >
      {title}
    </Text>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      aria-pressed={active}
      variant={active ? "subtle" : "ghost"}
      colorPalette={active ? "blue" : "gray"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function SettingsPanel({
  level,
  onLevel,
  packageCount,
  density,
  onDensity,
  edgeRouting,
  onEdgeRouting,
  communityCollapse,
  onCommunityCollapse,
  onClose,
}: SettingsPanelProps) {
  return (
    <Stack
      w="260px"
      h="full"
      p="4"
      gap="5"
      bg="bg.panel"
      borderLeftWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <Flex align="center" justify="space-between">
        <Text fontSize="sm" fontWeight="semibold">
          Settings
        </Text>
        <chakra.button
          type="button"
          aria-label="Close settings"
          onClick={onClose}
          color="fg.muted"
          _hover={{ color: "fg" }}
          fontSize="lg"
          lineHeight="1"
        >
          ✕
        </chakra.button>
      </Flex>

      <Box>
        <GroupLabel title="Abstraction level" />
        <Flex gap="2" wrap="wrap">
          {LEVELS.map((lv) => (
            <Choice key={lv} active={level === lv} onClick={() => onLevel(lv)}>
              {LEVEL_LABEL[lv]}
            </Choice>
          ))}
        </Flex>
        {(level === "package" || level === "workspace") && (
          <Text fontSize="xs" color="fg.muted" mt="2">
            {packageCount} package{packageCount === 1 ? "" : "s"} detected from manifests.
          </Text>
        )}
      </Box>

      <Box>
        <GroupLabel title="Density" />
        <HStack gap="2">
          {DENSITIES.map((d) => (
            <Choice key={d.label} active={density === d.value} onClick={() => onDensity(d.value)}>
              {d.label}
            </Choice>
          ))}
        </HStack>
        <Text fontSize="xs" color="fg.muted" mt="2">
          Node spacing for the Smart layout.
        </Text>
      </Box>

      <Box>
        <GroupLabel title="Edge routing" />
        <HStack gap="2">
          <Choice active={edgeRouting === "curved"} onClick={() => onEdgeRouting("curved")}>
            Curved
          </Choice>
          <Choice active={edgeRouting === "orthogonal"} onClick={() => onEdgeRouting("orthogonal")}>
            Orthogonal
          </Choice>
        </HStack>
      </Box>

      <Box>
        <GroupLabel title="Collapse community groups" />
        <Choice active={communityCollapse} onClick={() => onCommunityCollapse(!communityCollapse)}>
          {communityCollapse ? "On" : "Off"}
        </Choice>
        <Text fontSize="xs" color="fg.muted" mt="2">
          Folds every detected community into one card. Smart layout, Community grouping only.
        </Text>
      </Box>
    </Stack>
  );
}
