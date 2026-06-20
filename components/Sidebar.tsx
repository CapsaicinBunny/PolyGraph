"use client";

import { type ReactNode, useState } from "react";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import type { SavedSearch } from "@/lib/graph/query-language";
import { QueryBar, type QueryMode } from "./QueryBar";
import {
  EDGE_STYLES,
  FILTERABLE_EDGE_KINDS,
  FILTERABLE_NODE_KINDS,
  KIND_GLYPH,
  NODE_KIND_LAYERS,
  NODE_STYLES,
} from "@/lib/graph/visual";
import type { Environment, NodeCategory, NodeKind, Runtime } from "@/lib/graph/types";
import {
  DIRECTIONAL_ALGORITHMS,
  type GroupBy,
  type LayoutAlgorithm,
  type LayoutDirection,
} from "@/lib/layout";

interface SidebarProps {
  search: string;
  onSearch: (value: string) => void;
  queryMode: QueryMode;
  onQueryMode: (mode: QueryMode) => void;
  queryError?: string;
  matchCount?: number;
  builtinSearches: readonly SavedSearch[];
  savedSearches: SavedSearch[];
  onApplySearch: (query: string) => void;
  onSaveSearch: () => void;
  onDeleteSearch: (name: string) => void;
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
  /** Scope values actually present in the scanned graph; empty groups are hidden. */
  presentCategories: Set<NodeCategory>;
  presentEnvironments: Set<Environment>;
  presentRuntimes: Set<Runtime>;
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
  { value: "stress", label: "Stress", glyph: "◈" },
  { value: "backbone", label: "Backbone", glyph: "⊕" },
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
          {modified && (
            <Box
              data-testid={`section-modified-${title.toLowerCase()}`}
              w="6px"
              h="6px"
              rounded="full"
              bg="blue.solid"
              flexShrink={0}
            />
          )}
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

/** Small right-aligned "hide all" / "show all" toggle used on filter (sub)section headers. */
function HideAllToggle({ allOn, onToggle }: { allOn: boolean; onToggle: () => void }) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
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

export function Sidebar({
  search,
  onSearch,
  queryMode,
  onQueryMode,
  queryError,
  matchCount,
  builtinSearches,
  savedSearches,
  onApplySearch,
  onSaveSearch,
  onDeleteSearch,
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
  presentCategories,
  presentEnvironments,
  presentRuntimes,
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
  const allEdgesOn = enabledEdgeKinds.size === FILTERABLE_EDGE_KINDS.length;
  // No bulk edge setter prop exists, so drive "hide all" / "show all" by flipping just the kinds
  // that need it via the single-toggle prop (its setter is a functional update, so the calls
  // compound correctly).
  const setAllEdges = (on: boolean) => {
    for (const kind of FILTERABLE_EDGE_KINDS) {
      if (enabledEdgeKinds.has(kind) !== on) onToggleEdgeKind(kind);
    }
  };
  const nodeTypesModified = enabledNodeKinds.size !== FILTERABLE_NODE_KINDS.length;

  // Only surface scope values the codebase actually has. On a C/Rust project the
  // JS/TS-oriented Category / Environment / Runtime heuristics produce nothing,
  // so each group — and the whole section — collapses away.
  const categories = CATEGORIES.filter((c) => presentCategories.has(c.value));
  const environments = ENVIRONMENTS.filter((e) => presentEnvironments.has(e.value));
  const runtimes = RUNTIMES.filter((r) => presentRuntimes.has(r.value));
  const hasScope = categories.length > 0 || environments.length > 0 || runtimes.length > 0;
  // "Modified" iff a scope chip the user can actually SEE is turned off. Iterate the same
  // filtered lists the chips render from (not the raw present* sets), so a present value with no
  // rendered chip can never light the dot when every visible chip is on.
  const scopeModified =
    categories.some((c) => !enabledCategories.has(c.value)) ||
    environments.some((e) => !enabledEnvironments.has(e.value)) ||
    runtimes.some((r) => !enabledRuntimes.has(r.value));

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
      <QueryBar
        query={search}
        onQuery={onSearch}
        mode={queryMode}
        onMode={onQueryMode}
        error={queryError}
        matchCount={matchCount}
        builtins={builtinSearches}
        saved={savedSearches}
        onApply={onApplySearch}
        onSaveCurrent={onSaveSearch}
        onDelete={onDeleteSearch}
        onReset={onResetFilters}
      />

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
        {directionEnabled && (
          <Box mt="3">
            <MiniLabel>Direction</MiniLabel>
            <ChipRow>
              {DIRECTIONS.map((d) => (
                <Chip
                  key={d.value}
                  label={d.label}
                  glyph={d.glyph}
                  active={direction === d.value}
                  onClick={() => onDirection(d.value)}
                />
              ))}
            </ChipRow>
          </Box>
        )}
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

      <Section
        title="Relationships"
        modified={relationshipsModified}
        action={<HideAllToggle allOn={allEdgesOn} onToggle={() => setAllEdges(!allEdgesOn)} />}
      >
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
                  <HideAllToggle
                    allOn={allOn}
                    onToggle={() => onSetNodeKinds(layer.kinds, !allOn)}
                  />
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

      {hasScope && (
        <Section title="Scope" defaultOpen={false} modified={scopeModified}>
          <Stack gap="3">
            {categories.length > 0 && (
              <Box>
                <MiniLabel>Category</MiniLabel>
                <ChipRow>
                  {categories.map((c) => (
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
            )}
            {environments.length > 0 && (
              <Box>
                <MiniLabel>Environment</MiniLabel>
                <ChipRow>
                  {environments.map((e) => (
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
            )}
            {runtimes.length > 0 && (
              <Box>
                <MiniLabel>Runtime</MiniLabel>
                <ChipRow>
                  {runtimes.map((r) => (
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
            )}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
