"use client";

import { useState } from "react";
import { Box, Button, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { type Level, LEVELS } from "@/lib/graph/levels/types";
import { telemetry } from "@/lib/telemetry";

// Save the buffered telemetry as an NDJSON file — the downloadable "session log".
// Best-effort: a blocked blob URL / OOM must not throw out of the click handler.
function downloadSessionLog() {
  try {
    const blob = new Blob([telemetry.toNDJSON()], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `polygraph-session-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("[polygraph] couldn't generate the session log", err);
  }
}

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
  adaptiveLod: boolean;
  onAdaptiveLod: (v: boolean) => void;
  minimap: boolean;
  onMinimap: (v: boolean) => void;
  edgeRouting: "curved" | "orthogonal";
  onEdgeRouting: (v: "curved" | "orthogonal") => void;
  communityCollapse: boolean;
  onCommunityCollapse: (v: boolean) => void;
  telemetryOn: boolean;
  onTelemetry: (v: boolean) => void;
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

function CheckRow({
  checked,
  onClick,
  label,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <chakra.button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onClick}
      display="flex"
      alignItems="center"
      gap="2"
      w="full"
      textAlign="left"
    >
      <Box
        w="16px"
        h="16px"
        rounded="sm"
        flexShrink="0"
        borderWidth="1px"
        borderColor={checked ? "blue.solid" : "border.emphasized"}
        bg={checked ? "blue.solid" : "transparent"}
        color="white"
        display="flex"
        alignItems="center"
        justifyContent="center"
        fontSize="11px"
        lineHeight="1"
      >
        {checked ? "✓" : ""}
      </Box>
      <Text fontSize="sm" color="fg">
        {label}
      </Text>
    </chakra.button>
  );
}

export function SettingsPanel({
  level,
  onLevel,
  packageCount,
  density,
  onDensity,
  adaptiveLod,
  onAdaptiveLod,
  minimap,
  onMinimap,
  edgeRouting,
  onEdgeRouting,
  communityCollapse,
  onCommunityCollapse,
  telemetryOn,
  onTelemetry,
  onClose,
}: SettingsPanelProps) {
  const [, setTick] = useState(0); // forces a re-render so the captured-count refreshes
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
        <GroupLabel title="Adaptive LOD" />
        <CheckRow
          checked={adaptiveLod}
          onClick={() => onAdaptiveLod(!adaptiveLod)}
          label="Camera-driven level of detail"
        />
        <Text fontSize="xs" color="fg.muted" mt="2">
          Collapses off-screen and distant directories as you zoom — keeps huge graphs fast. On by
          default.
        </Text>
      </Box>

      <Box>
        <GroupLabel title="Minimap" />
        <CheckRow
          checked={minimap}
          onClick={() => onMinimap(!minimap)}
          label="Show navigation minimap"
        />
        <Text fontSize="xs" color="fg.muted" mt="2">
          A graph-extent overview with the current viewport; click or drag it to recenter. On by
          default.
        </Text>
      </Box>

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

      <Box>
        <GroupLabel title="Analytics & logging" />
        <CheckRow
          checked={telemetryOn}
          onClick={() => onTelemetry(!telemetryOn)}
          label="Capture diagnostics (LOD, rendering, analysis)"
        />
        <Text fontSize="xs" color="fg.muted" mt="2">
          Structured console logs plus a downloadable session log — deep LOD-cut traces, per-frame
          render stats, and scan/analyze timings. On by default; nothing leaves your machine.
        </Text>
        <HStack gap="2" mt="3">
          <Button size="sm" variant="outline" onClick={downloadSessionLog}>
            Download session log
          </Button>
          <Button
            size="sm"
            variant="ghost"
            colorPalette="gray"
            onClick={() => {
              telemetry.clearAll();
              setTick((t) => t + 1);
            }}
          >
            Clear
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.subtle" mt="2">
          {telemetry.eventCount().toLocaleString()} events captured this session.
        </Text>
      </Box>
    </Stack>
  );
}
