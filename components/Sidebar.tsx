"use client";

import { type ReactNode, useState } from "react";
import { Box, Button, Flex, HStack, Input, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import {
  EDGE_STYLES,
  EXTERNAL_STYLES,
  FILTERABLE_EDGE_KINDS,
  FILTERABLE_NODE_KINDS,
  KIND_GLYPH,
  NODE_KIND_LAYERS,
  NODE_STYLES,
  ROLE_STYLES,
} from "@/lib/graph/visual";
import type {
  Environment,
  ExternalKind,
  NodeCategory,
  NodeKind,
  NodeRole,
  Runtime,
} from "@/lib/graph/types";
import {
  DIRECTIONAL_ALGORITHMS,
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
} from "@/lib/layout";

interface SidebarProps {
  search: string;
  onSearch: (value: string) => void;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  onToggleEdgeKind: (kind: ViewEdgeKind) => void;
  enabledNodeKinds: Set<NodeKind>;
  onToggleNodeKind: (kind: NodeKind) => void;
  onSetNodeKinds: (kinds: NodeKind[], on: boolean) => void;
  enabledCategories: Set<NodeCategory>;
  onToggleCategory: (category: NodeCategory) => void;
  enabledEnvironments: Set<Environment>;
  onToggleEnvironment: (env: Environment) => void;
  enabledRuntimes: Set<Runtime>;
  onToggleRuntime: (rt: Runtime) => void;
  onResetFilters: () => void;
  algorithm: LayoutAlgorithm;
  onAlgorithm: (algorithm: LayoutAlgorithm) => void;
  direction: LayoutDirection;
  onDirection: (direction: LayoutDirection) => void;
  groupBy: GroupBy;
  onGroupBy: (groupBy: GroupBy) => void;
}

const CATEGORIES: { value: NodeCategory; label: string; color: string }[] = [
  { value: "ui", label: "UI", color: "#22c55e" },
  { value: "feature", label: "Feature", color: "#3b82f6" },
];

const ENVIRONMENTS: { value: Environment; label: string; color: string }[] = [
  { value: "client", label: "Client", color: "#fb923c" },
  { value: "server", label: "Server", color: "#2dd4bf" },
];

const RUNTIMES: { value: Runtime; label: string; color: string }[] = [
  { value: "node", label: "node", color: "#4ade80" },
  { value: "deno", label: "deno", color: "#60a5fa" },
  { value: "bun", label: "bun", color: "#f472b6" },
];

const ALGORITHMS: { value: LayoutAlgorithm; label: string; glyph: string }[] = [
  { value: "smart", label: "Smart", glyph: "✦" },
  { value: "layered", label: "Layered", glyph: "▤" },
  { value: "tree", label: "Tree", glyph: "⌄" },
  { value: "radial", label: "Radial", glyph: "◎" },
  { value: "circular", label: "Circular", glyph: "○" },
  { value: "grid", label: "Grid", glyph: "▦" },
  { value: "force", label: "Force", glyph: "✸" },
];

const GROUP_BY: { value: GroupBy; label: string; glyph: string }[] = [
  { value: "directory", label: "Directory", glyph: "🗀" },
  { value: "community", label: "Community", glyph: "⬡" },
  { value: "none", label: "None", glyph: "∅" },
];

const DIRECTIONS: { value: LayoutDirection; label: string; glyph: string }[] = [
  { value: "TB", label: "Top down", glyph: "↓" },
  { value: "LR", label: "Left → right", glyph: "→" },
  { value: "BT", label: "Bottom up", glyph: "↑" },
  { value: "RL", label: "Right → left", glyph: "←" },
];

const ACCENT = "#3b82f6";
const BORDER_VAR = "var(--chakra-colors-border)";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 0.15s ease",
        color: "var(--chakra-colors-fg-muted)",
        flexShrink: 0,
      }}
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Section({
  title,
  defaultOpen = true,
  modified = false,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  modified?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((o) => !o);
  return (
    <Box>
      <Flex align="center" justify="space-between" gap="2">
        <HStack
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
          gap="2"
          flex="1"
          py="1"
          cursor="pointer"
          color="fg.muted"
          _hover={{ color: "fg" }}
        >
          <Chevron open={open} />
          <Text
            fontSize="11px"
            fontWeight="semibold"
            textTransform="uppercase"
            letterSpacing="wider"
          >
            {title}
          </Text>
          {modified && <Box w="6px" h="6px" rounded="full" bg="blue.solid" flexShrink={0} />}
        </HStack>
        {action}
      </Flex>
      {open && (
        <Box mt="2.5" mb="1">
          {children}
        </Box>
      )}
    </Box>
  );
}

function Chip({
  label,
  active,
  onClick,
  color,
  glyph,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
  glyph?: string;
  disabled?: boolean;
}) {
  const accent = color ?? ACCENT;
  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={active}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      px="2.5"
      py="1"
      rounded="full"
      borderWidth="1px"
      fontSize="xs"
      fontWeight="medium"
      userSelect="none"
      whiteSpace="nowrap"
      cursor={disabled ? "not-allowed" : "pointer"}
      color={active ? "fg" : "fg.muted"}
      opacity={disabled ? 0.3 : active ? 1 : 0.6}
      transition="opacity 0.12s, background-color 0.12s, border-color 0.12s"
      _hover={disabled ? undefined : { opacity: 1 }}
      style={{
        backgroundColor: active ? `${accent}26` : "transparent",
        borderColor: active ? accent : BORDER_VAR,
      }}
    >
      {glyph ? (
        <Text
          as="span"
          w="14px"
          textAlign="center"
          lineHeight="1"
          fontWeight="bold"
          flexShrink={0}
          style={{ color: color ? accent : undefined }}
        >
          {glyph}
        </Text>
      ) : (
        <Box w="7px" h="7px" rounded="full" flexShrink={0} style={{ backgroundColor: accent }} />
      )}
      {label}
    </Box>
  );
}

function ChipRow({ children }: { children: ReactNode }) {
  return (
    <Flex wrap="wrap" gap="1.5">
      {children}
    </Flex>
  );
}

function MiniLabel({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="10px" color="fg.subtle" textTransform="uppercase" letterSpacing="wide" mb="1.5">
      {children}
    </Text>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <HStack gap="2">
      <Box w="8px" h="8px" rounded="full" flexShrink={0} style={{ backgroundColor: color }} />
      <Text fontSize="xs" color="fg.muted" lineClamp={1}>
        {label}
      </Text>
    </HStack>
  );
}

export function Sidebar({
  search,
  onSearch,
  enabledEdgeKinds,
  onToggleEdgeKind,
  enabledNodeKinds,
  onToggleNodeKind,
  onSetNodeKinds,
  enabledCategories,
  onToggleCategory,
  enabledEnvironments,
  onToggleEnvironment,
  enabledRuntimes,
  onToggleRuntime,
  onResetFilters,
  algorithm,
  onAlgorithm,
  direction,
  onDirection,
  groupBy,
  onGroupBy,
}: SidebarProps) {
  const directionEnabled = DIRECTIONAL_ALGORITHMS.includes(algorithm);

  const relationshipsModified = enabledEdgeKinds.size !== FILTERABLE_EDGE_KINDS.length;
  const nodeTypesModified = enabledNodeKinds.size !== FILTERABLE_NODE_KINDS.length;
  const scopeModified =
    enabledCategories.size !== CATEGORIES.length ||
    enabledEnvironments.size !== ENVIRONMENTS.length ||
    enabledRuntimes.size !== RUNTIMES.length;

  return (
    <Stack
      w="256px"
      h="full"
      p="4"
      gap="5"
      bg="bg.panel"
      borderRightWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <HStack gap="2">
        <Input
          size="sm"
          rounded="lg"
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          colorPalette="gray"
          onClick={onResetFilters}
          flexShrink={0}
        >
          Reset
        </Button>
      </HStack>

      <Section title="Layout">
        <ChipRow>
          {ALGORITHMS.map((a) => (
            <Chip
              key={a.value}
              label={a.label}
              glyph={a.glyph}
              active={algorithm === a.value}
              onClick={() => onAlgorithm(a.value)}
            />
          ))}
        </ChipRow>
        <Box mt="3">
          <MiniLabel>Direction{directionEnabled ? "" : " · layered / tree only"}</MiniLabel>
          <ChipRow>
            {DIRECTIONS.map((d) => (
              <Chip
                key={d.value}
                label={d.label}
                glyph={d.glyph}
                active={direction === d.value}
                disabled={!directionEnabled}
                onClick={() => onDirection(d.value)}
              />
            ))}
          </ChipRow>
        </Box>
        {algorithm === "smart" && (
          <Box mt="3">
            <MiniLabel>Group by</MiniLabel>
            <ChipRow>
              {GROUP_BY.map((g) => (
                <Chip
                  key={g.value}
                  label={g.label}
                  glyph={g.glyph}
                  active={groupBy === g.value}
                  onClick={() => onGroupBy(g.value)}
                />
              ))}
            </ChipRow>
          </Box>
        )}
      </Section>

      <Section title="Relationships" modified={relationshipsModified}>
        <ChipRow>
          {FILTERABLE_EDGE_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={EDGE_STYLES[kind].label}
              color={EDGE_STYLES[kind].color}
              active={enabledEdgeKinds.has(kind)}
              onClick={() => onToggleEdgeKind(kind)}
            />
          ))}
        </ChipRow>
      </Section>

      <Section title="Node types" modified={nodeTypesModified}>
        <Text fontSize="10px" color="fg.subtle" mb="2.5">
          Applies to symbols inside expanded files. To filter files, use the Filters panel
          (top-right).
        </Text>
        <Stack gap="3">
          {NODE_KIND_LAYERS.map((layer) => {
            const allOn = layer.kinds.every((k) => enabledNodeKinds.has(k));
            return (
              <Box key={layer.label}>
                <Flex align="center" justify="space-between" mb="1.5">
                  <Text
                    fontSize="10px"
                    color="fg.subtle"
                    textTransform="uppercase"
                    letterSpacing="wide"
                  >
                    {layer.label}
                  </Text>
                  <Box
                    role="button"
                    tabIndex={0}
                    onClick={() => onSetNodeKinds(layer.kinds, !allOn)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSetNodeKinds(layer.kinds, !allOn);
                      }
                    }}
                    fontSize="10px"
                    color="fg.subtle"
                    cursor="pointer"
                    userSelect="none"
                    _hover={{ color: "fg" }}
                  >
                    {allOn ? "hide all" : "show all"}
                  </Box>
                </Flex>
                <ChipRow>
                  {layer.kinds.map((kind) => (
                    <Chip
                      key={kind}
                      label={NODE_STYLES[kind].label}
                      color={NODE_STYLES[kind].color}
                      glyph={KIND_GLYPH[kind]}
                      active={enabledNodeKinds.has(kind)}
                      onClick={() => onToggleNodeKind(kind)}
                    />
                  ))}
                </ChipRow>
              </Box>
            );
          })}
        </Stack>
      </Section>

      <Section title="Scope" defaultOpen={false} modified={scopeModified}>
        <Stack gap="3">
          <Box>
            <MiniLabel>Category</MiniLabel>
            <ChipRow>
              {CATEGORIES.map((c) => (
                <Chip
                  key={c.value}
                  label={c.label}
                  color={c.color}
                  active={enabledCategories.has(c.value)}
                  onClick={() => onToggleCategory(c.value)}
                />
              ))}
            </ChipRow>
          </Box>
          <Box>
            <MiniLabel>Environment</MiniLabel>
            <ChipRow>
              {ENVIRONMENTS.map((e) => (
                <Chip
                  key={e.value}
                  label={e.label}
                  color={e.color}
                  active={enabledEnvironments.has(e.value)}
                  onClick={() => onToggleEnvironment(e.value)}
                />
              ))}
            </ChipRow>
          </Box>
          <Box>
            <MiniLabel>Runtime</MiniLabel>
            <ChipRow>
              {RUNTIMES.map((r) => (
                <Chip
                  key={r.value}
                  label={r.label}
                  color={r.color}
                  active={enabledRuntimes.has(r.value)}
                  onClick={() => onToggleRuntime(r.value)}
                />
              ))}
            </ChipRow>
          </Box>
        </Stack>
      </Section>

      <Section title="Legend" defaultOpen={false}>
        <Stack gap="4">
          <Box>
            <MiniLabel>Detected roles</MiniLabel>
            <SimpleGrid columns={2} gap="2">
              {(Object.keys(ROLE_STYLES) as NodeRole[]).map((role) => (
                <LegendItem
                  key={role}
                  color={ROLE_STYLES[role].color}
                  label={ROLE_STYLES[role].label}
                />
              ))}
            </SimpleGrid>
          </Box>
          <Box>
            <MiniLabel>External sources</MiniLabel>
            <SimpleGrid columns={2} gap="2">
              {(Object.keys(EXTERNAL_STYLES) as ExternalKind[]).map((ext) => (
                <LegendItem
                  key={ext}
                  color={EXTERNAL_STYLES[ext].color}
                  label={EXTERNAL_STYLES[ext].label}
                />
              ))}
            </SimpleGrid>
            <Text fontSize="11px" color="fg.subtle" mt="2.5" lineHeight="1.5">
              Toggle “Externals” in the toolbar to show imported packages and Node/Deno/Bun APIs.
            </Text>
          </Box>
        </Stack>
      </Section>
    </Stack>
  );
}
