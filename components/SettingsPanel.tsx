"use client";

import { useState } from "react";
import { Box, Button, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { saveTextFile } from "@/lib/client/download";
import { type Level, LEVELS } from "@/lib/graph/levels/types";
import { telemetry } from "@/lib/telemetry";

// Save the buffered telemetry as an NDJSON file via a native Save-As dialog (desktop)
// or a browser download. Best-effort: a failure must not throw out of the handler.
async function downloadSessionLog() {
  try {
    const name = `polygraph-session-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
    await saveTextFile(name, telemetry.toNDJSON(), "application/x-ndjson");
  } catch (err) {
    console.error("[polygraph] couldn't save the session log", err);
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

// LOD detail = the representation-LOD refine-gate openPx, set LIVE (no rebuild). Higher detail =
// lower openPx = proxies refine at a smaller on-screen size = less combining. Normal=120 matches
// the Explorer default so the shipped state has an exact level.
const DETAIL_LEVELS: { value: number; label: string }[] = [
  { value: 240, label: "Sparse" },
  { value: 120, label: "Normal" },
  { value: 80, label: "Detailed" },
  { value: 50, label: "Max" },
];
// The LOD-detail slider spans openPx [LOD_PX_MAX, LOD_PX_SPARSE]. Its 0..100 "detail" scale maps
// INVERSELY — 0 = Sparse (high openPx, left), 100 = Max detail (low openPx, right) — so dragging
// right shows more. The two maps are shared so the displayed value and the committed openPx can't
// drift apart.
const LOD_PX_SPARSE = 240;
const LOD_PX_MAX = 50;
const detailFromOpenPx = (px: number): number =>
  Math.round(((LOD_PX_SPARSE - px) / (LOD_PX_SPARSE - LOD_PX_MAX)) * 100);
const openPxFromDetail = (d: number): number =>
  Math.round(LOD_PX_SPARSE - (d / 100) * (LOD_PX_SPARSE - LOD_PX_MAX));
// Nearest named level, for the live caption.
function lodDetailLabel(openPx: number): string {
  return DETAIL_LEVELS.reduce((best, d) =>
    Math.abs(d.value - openPx) < Math.abs(best.value - openPx) ? d : best,
  ).label;
}

interface SettingsPanelProps {
  level: Level;
  onLevel: (v: Level) => void;
  packageCount: number;
  density: number;
  onDensity: (v: number) => void;
  lodOpenPx: number;
  onLodOpenPx: (v: number) => void;
  minimap: boolean;
  onMinimap: (v: boolean) => void;
  edgeRouting: "curved" | "orthogonal";
  onEdgeRouting: (v: "curved" | "orthogonal") => void;
  telemetryOn: boolean;
  onTelemetry: (v: boolean) => void;
  lodOverlay: boolean;
  onLodOverlay: (v: boolean) => void;
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
  lodOpenPx,
  onLodOpenPx,
  minimap,
  onMinimap,
  edgeRouting,
  onEdgeRouting,
  telemetryOn,
  onTelemetry,
  lodOverlay,
  onLodOverlay,
  onClose,
}: SettingsPanelProps) {
  // Local drag state so the slider thumb tracks smoothly, but the openPx commit (which re-cuts +
  // re-lays-out the scene) fires only on release — committing on every drag step would relayout
  // per step. null ⇒ not dragging ⇒ derive the thumb position from the live prop.
  const [dragDetail, setDragDetail] = useState<number | null>(null);
  const detail = dragDetail ?? detailFromOpenPx(lodOpenPx);
  const commitDetail = () => {
    if (dragDetail != null) {
      onLodOpenPx(openPxFromDetail(dragDetail));
      setDragDetail(null);
    }
  };
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
        <Stack gap="2.5">
          <CheckRow
            checked={minimap}
            onClick={() => onMinimap(!minimap)}
            label="Show navigation minimap"
          />
          <CheckRow
            checked={telemetryOn}
            onClick={() => onTelemetry(!telemetryOn)}
            label="Local logs"
          />
          <CheckRow
            checked={lodOverlay}
            onClick={() => onLodOverlay(!lodOverlay)}
            label="Show LOD diagnostics"
          />
        </Stack>
        <HStack gap="2" mt="3">
          <Button
            size="xs"
            variant="ghost"
            colorPalette="gray"
            onClick={() => void downloadSessionLog()}
          >
            Download log
          </Button>
          <Button
            size="xs"
            variant="ghost"
            colorPalette="gray"
            onClick={() => telemetry.clearAll()}
          >
            Clear
          </Button>
        </HStack>
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
        <GroupLabel title="LOD detail" />
        <Flex align="center" gap="3">
          <Text fontSize="11px" color="fg.muted" flexShrink="0">
            Sparse
          </Text>
          <chakra.input
            type="range"
            min={0}
            max={100}
            step={5}
            aria-label="LOD detail"
            value={detail}
            onChange={(e) => setDragDetail(Number(e.currentTarget.value))}
            onPointerUp={commitDetail}
            onKeyUp={commitDetail}
            onBlur={commitDetail}
            flex="1"
            cursor="pointer"
            style={{ accentColor: "#4f8ff7" }}
          />
          <Text fontSize="11px" color="fg.muted" flexShrink="0">
            Max
          </Text>
        </Flex>
        <Text fontSize="xs" color="fg.muted" mt="2">
          How readily groups expand into detail as you zoom — currently {lodDetailLabel(lodOpenPx)}.
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
    </Stack>
  );
}
