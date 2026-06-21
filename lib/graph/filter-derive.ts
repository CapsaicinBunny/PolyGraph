// Derive the dynamic filter UI from the dimension registry (Phase B task 2).
//
// A pure helper: from (graph, catalog, index) it returns, for every filterable
// facet dimension, the values actually present() with their handshake
// label/color/glyph and a node count, plus DimensionStats (distinct values,
// coverage, largest-bucket fraction, eligibility) so the Sidebar can render one
// honest, registry-driven section per dimension — and gate low-information ones.
//
// kind/folder/language are excluded by default: kind keeps its dedicated layered
// "Node types" section and folder/language live in the FiltersPanel. Everything
// else — category, env, runtime, role, and any provider facet (rust.visibility,
// go.exported, …) — is surfaced here automatically.

import type { DimensionCatalog, DimensionValue, FacetKey } from "./dimensions";
import type { DimensionIndex } from "./dimension-index";
import type { GraphModel } from "./types";

/** One value of a filterable dimension, ready to render as a chip. */
export interface FilterValue {
  value: string;
  label: string;
  color: string;
  glyph?: string;
  /** Nodes carrying this value (default values count their complement). */
  count: number;
  /** False for a value outside a closed domain (surfaced, not dropped). */
  declared: boolean;
}

/** Group-by-style eligibility signals for a dimension (spec review §14). */
export interface DimensionStats {
  /** Distinct values present (incl. an unmaterialized default). */
  distinctValues: number;
  /** Fraction of nodes carrying at least one value, 0..1. */
  coverage: number;
  /** Fraction of the largest single value's bucket over total nodes, 0..1. */
  largestBucketFraction: number;
  /** Passes the eligibility gate (≥2 values, coverage >20%, largest bucket <98%). */
  eligible: boolean;
}

/** A filterable dimension projected for the UI: its values (with counts) + stats. */
export interface FilterDimension {
  key: FacetKey;
  label: string;
  dimension: "structural" | "facet";
  cardinality: "single" | "multi";
  values: FilterValue[];
  stats: DimensionStats;
}

/** Dimensions with their own dedicated UI, so the generic derivation skips them. */
const DEFAULT_EXCLUDE: ReadonlySet<FacetKey> = new Set(["kind", "folder", "language"]);

// Eligibility thresholds (spec "Group-by eligibility", reused for filter default-visibility).
const MIN_DISTINCT = 2;
const MIN_COVERAGE = 0.2;
const MAX_LARGEST_BUCKET = 0.98;

/** Deterministic readable hex color for a value with no declared color. */
function fallbackColor(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  // HSL → hex at mid saturation/lightness so it reads on light and dark panels.
  const s = 0.5;
  const l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Derive the filterable facet dimensions for the dynamic Sidebar. */
export function deriveFilterDimensions(
  graph: GraphModel,
  catalog: DimensionCatalog,
  index: DimensionIndex,
  exclude: ReadonlySet<FacetKey> = DEFAULT_EXCLUDE,
): FilterDimension[] {
  const total = graph.nodes.length;
  const out: FilterDimension[] = [];

  for (const descriptor of catalog.descriptors) {
    if (!descriptor.filterable || exclude.has(descriptor.key)) continue;

    const declaredMeta = new Map<string, DimensionValue>(
      descriptor.values.map((v) => [v.value, v]),
    );

    const present = index.present(descriptor.key);
    if (present.length === 0) continue; // nothing in this graph → no section

    // Build a value-id lookup so counts read straight off the columnar postings.
    const values: FilterValue[] = present.map((p, id) => {
      const meta = declaredMeta.get(p.value);
      // present() ids are dense 0..n-1 in first-seen order, matching the index's
      // interned ids — so the posting for this value is nodesWithValueId(key, id).
      const count = index.nodesWithValueId(descriptor.key, id).length;
      return {
        value: p.value,
        label: meta?.label ?? p.value,
        color: meta?.color ?? fallbackColor(p.value),
        glyph: meta?.glyph,
        count,
        declared: p.declared,
      };
    });

    // Coverage: nodes carrying ≥1 value for this dimension (a defaulted facet
    // resolves every node to a value → coverage 1).
    let covered = 0;
    for (let ord = 0; ord < total; ord++) {
      if (index.valuesOfOrdinal(ord, descriptor.key).length > 0) covered++;
    }
    const coverage = total === 0 ? 0 : covered / total;
    const largestBucket = values.reduce((max, v) => Math.max(max, v.count), 0);
    const largestBucketFraction = total === 0 ? 0 : largestBucket / total;

    const distinctValues = values.length;
    const eligible =
      distinctValues >= MIN_DISTINCT &&
      coverage > MIN_COVERAGE &&
      largestBucketFraction < MAX_LARGEST_BUCKET;

    values.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    out.push({
      key: descriptor.key,
      label: descriptor.label,
      dimension: descriptor.dimension,
      cardinality: descriptor.cardinality,
      values,
      stats: { distinctValues, coverage, largestBucketFraction, eligible },
    });
  }

  return out;
}
