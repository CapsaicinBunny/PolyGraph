"use client";

import { type ReactNode, useMemo, useState } from "react";
import { Box, Flex, HStack, Input, Stack, Text } from "@chakra-ui/react";
import type { ViewEdgeKind } from "@/lib/aggregate";
import type { FacetKey } from "@/lib/graph/dimensions";
import { type FacetSelection, valueEnabled } from "@/lib/graph/facet-selection";
import type { FilterDimension, FilterValue } from "@/lib/graph/filter-derive";
import type { SavedSearch } from "@/lib/graph/query-language";
import { QueryBar, type QueryMode } from "./QueryBar";
import {
  EDGE_STYLES,
  FILTERABLE_EDGE_KINDS,
  KIND_GLYPH,
  NODE_KIND_LAYERS,
  NODE_STYLES,
} from "@/lib/graph/visual";
import type { NodeKind } from "@/lib/graph/types";
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
  /** Bulk edge-kind setter (all / none); optional — falls back to per-kind toggles. */
  onSetEdgeKinds?: (kinds: ViewEdgeKind[], on: boolean) => void;
  /**
   * Sparse facet selections (kind/category/env/runtime/role + provider facets).
   * No entry for a key ⇒ all of its values enabled.
   */
  enabledFacets: Map<FacetKey, FacetSelection>;
  /**
   * The filterable facet dimensions present in this graph (from
   * deriveFilterDimensions): one collapsible section each, with per-value counts
   * + eligibility. EXCLUDES kind (its dedicated Node-types section below) and
   * folder/language (the FiltersPanel).
   */
  filterDimensions: FilterDimension[];
  /** Toggle one value of a facet on/off. */
  onToggleFacetValue: (key: FacetKey, value: string) => void;
  /** Enable/disable a set of a facet's values at once (per-section all/none, layers). */
  onSetFacetValues: (key: FacetKey, values: string[], on: boolean) => void;
  onResetFilters: () => void;
  algorithm: LayoutAlgorithm;
  onAlgorithm: (algorithm: LayoutAlgorithm) => void;
  direction: LayoutDirection;
  onDirection: (direction: LayoutDirection) => void;
  groupBy: GroupBy;
  onGroupBy: (groupBy: GroupBy) => void;
  /**
   * The eligible grouping modes for this graph (Phase C1a) — Directory, Package (when
   * manifests exist), Community, eligible groupable facets, then None. Replaces the
   * fixed directory/community/none chips.
   */
  groupByOptions: { key: string; label: string; glyph: string }[];
}

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

const DIRECTIONS: { value: LayoutDirection; label: string; glyph: string }[] = [
  { value: "TB", label: "Top down", glyph: "↓" },
  { value: "LR", label: "Left → right", glyph: "→" },
  { value: "BT", label: "Bottom up", glyph: "↑" },
  { value: "RL", label: "Right → left", glyph: "←" },
];

// Above this many total facet values, offer the filter-search box so a polyglot
// repo's many sections stay navigable.
const SEARCH_VALUE_THRESHOLD = 10;

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
  forceOpen = false,
  modified = false,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /**
   * Force the body open regardless of the user's manual toggle (used by the
   * filter-search to reveal matches inside an otherwise-collapsed section). React
   * only reads `defaultOpen` at mount, so a section that becomes relevant *after*
   * mount — e.g. when a query matches a value living in a collapsed, ineligible
   * dimension — needs this override to actually open. The user's manual state is
   * preserved underneath and restored once the override clears.
   */
  forceOpen?: boolean;
  modified?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((o) => !o);
  const effectiveOpen = open || forceOpen;
  return (
    <Box>
      <Flex align="center" justify="space-between" gap="2">
        <HStack
          role="button"
          tabIndex={0}
          aria-expanded={effectiveOpen}
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
          <Chevron open={effectiveOpen} />
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
      {effectiveOpen && (
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
  count,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
  glyph?: string;
  count?: number;
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
      {count !== undefined && (
        <Text as="span" fontSize="10px" color="fg.subtle" ml="0.5">
          {count}
        </Text>
      )}
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

/** One dynamic facet dimension as a collapsible section of value chips with counts. */
function FacetSection({
  dim,
  enabledFacets,
  onToggleFacetValue,
  onSetFacetValues,
  match,
}: {
  dim: FilterDimension;
  enabledFacets: Map<FacetKey, FacetSelection>;
  onToggleFacetValue: (key: FacetKey, value: string) => void;
  onSetFacetValues: (key: FacetKey, values: string[], on: boolean) => void;
  /** Lowercased filter-search query; "" shows everything. */
  match: string;
}) {
  const shown: FilterValue[] = match
    ? dim.values.filter((v) => v.label.toLowerCase().includes(match))
    : dim.values;
  if (shown.length === 0) return null;

  const allValues = dim.values.map((v) => v.value);
  const allOn = allValues.every((v) => valueEnabled(enabledFacets, dim.key, v));
  // A dominant/single-bucket (ineligible) dimension is collapsed by default so it
  // doesn't clutter the panel. An active filter-search must still reveal a match that
  // lives inside such a collapsed section, so force it open while searching (`shown`
  // is already narrowed to the matches; this section only renders at all when it has
  // ≥1). `defaultOpen` stays the honest mount-time state; `forceOpen` is the dynamic
  // search override (a one-time `useState(defaultOpen)` can't react to a later query).
  const defaultOpen = dim.stats.eligible;
  const forceOpen = match.length > 0;
  const modified = !allOn;

  return (
    <Section
      title={dim.label}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      modified={modified}
      action={
        <HideAllToggle
          allOn={allOn}
          onToggle={() => onSetFacetValues(dim.key, allValues, !allOn)}
        />
      }
    >
      <ChipRow>
        {shown.map((v) => (
          <Chip
            key={v.value}
            label={v.label}
            color={v.color}
            glyph={v.glyph}
            count={v.count}
            active={valueEnabled(enabledFacets, dim.key, v.value)}
            onClick={() => onToggleFacetValue(dim.key, v.value)}
          />
        ))}
      </ChipRow>
    </Section>
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
  onSetEdgeKinds,
  enabledFacets,
  filterDimensions,
  onToggleFacetValue,
  onSetFacetValues,
  onResetFilters,
  algorithm,
  onAlgorithm,
  direction,
  onDirection,
  groupBy,
  onGroupBy,
  groupByOptions,
}: SidebarProps) {
  const directionEnabled = DIRECTIONAL_ALGORITHMS.includes(algorithm);
  const [facetQuery, setFacetQuery] = useState("");

  const relationshipsModified = enabledEdgeKinds.size !== FILTERABLE_EDGE_KINDS.length;
  const allEdgesOn = enabledEdgeKinds.size === FILTERABLE_EDGE_KINDS.length;
  const setAllEdges = (on: boolean) => {
    if (onSetEdgeKinds) {
      onSetEdgeKinds([...FILTERABLE_EDGE_KINDS], on);
      return;
    }
    // Fallback: drive "hide all"/"show all" via the single-toggle prop.
    for (const kind of FILTERABLE_EDGE_KINDS) {
      if (enabledEdgeKinds.has(kind) !== on) onToggleEdgeKind(kind);
    }
  };

  // The kind dimension drives the Node-types section through the generic facet
  // selection (no enabledNodeKinds set any more). A kind is enabled unless the
  // sparse selection excludes it.
  const kindEnabled = (kind: NodeKind) => valueEnabled(enabledFacets, "kind", kind);
  const nodeTypesModified = NODE_KIND_LAYERS.some((layer) =>
    layer.kinds.some((k) => !kindEnabled(k)),
  );

  // Offer the filter-search box once a polyglot repo accumulates many facet values.
  const totalFacetValues = useMemo(
    () => filterDimensions.reduce((sum, d) => sum + d.values.length, 0),
    [filterDimensions],
  );
  const showFacetSearch = totalFacetValues >= SEARCH_VALUE_THRESHOLD;
  const match = facetQuery.trim().toLowerCase();

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
              {groupByOptions.map((g) => (
                <Chip
                  key={g.key}
                  label={g.label}
                  glyph={g.glyph}
                  active={groupBy === g.key}
                  onClick={() => onGroupBy(g.key)}
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
            const allOn = layer.kinds.every((k) => kindEnabled(k));
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
                    onToggle={() => onSetFacetValues("kind", layer.kinds, !allOn)}
                  />
                </Flex>
                <ChipRow>
                  {layer.kinds.map((kind) => (
                    <Chip
                      key={kind}
                      label={NODE_STYLES[kind].label}
                      color={NODE_STYLES[kind].color}
                      glyph={KIND_GLYPH[kind]}
                      active={kindEnabled(kind)}
                      onClick={() => onToggleFacetValue("kind", kind)}
                    />
                  ))}
                </ChipRow>
              </Box>
            );
          })}
        </Stack>
      </Section>

      {/* Dynamic, registry-driven facet sections (category / env / runtime / role /
          provider facets). One collapsible section per present() dimension, value
          chips with counts, sparse toggles + all/none, and a filter-search when many. */}
      {showFacetSearch && (
        <Input
          size="xs"
          placeholder="Filter values…"
          value={facetQuery}
          onChange={(e) => setFacetQuery(e.target.value)}
        />
      )}
      {filterDimensions.map((dim) => (
        <FacetSection
          key={dim.key}
          dim={dim}
          enabledFacets={enabledFacets}
          onToggleFacetValue={onToggleFacetValue}
          onSetFacetValues={onSetFacetValues}
          match={match}
        />
      ))}
    </Stack>
  );
}
