// Derive the eligible Group-by modes from the dimension registry (Phase C1a task 5).
//
// C0/C1a's grouping modes were the three fixed chips (Directory / Community / None). This
// replaces them with the modes the current graph actually supports: the built-ins, plus
// Package when manifests exist, plus every ELIGIBLE groupable facet (a facet whose
// FacetGrouping is not `disabled` and whose DimensionStats pass — ≥2 values, >20%
// coverage, largest bucket <98%, the same gate the filter UI uses for default-visibility).
//
// Pure: from (graph, catalog, index, hasManifests) it returns the ordered list of modes
// the Sidebar renders as chips and the Explorer wires through scene/snapshot/cut. The
// `key` is the grouping modeKey ("directory" / "community" / "package" / "facet:<key>" /
// "none"); facet keys are namespaced so they can never collide with a built-in.

import type { DimensionCatalog, FacetKey } from "./dimensions";
import type { DimensionIndex } from "./dimension-index";
import type { GraphModel } from "./types";

/** One offered grouping mode: its modeKey, display label, and a glyph. */
export interface GroupByOption {
  /** The grouping modeKey ("directory" / "community" / "package" / "facet:<key>" / "none"). */
  key: string;
  label: string;
  glyph: string;
}

// Eligibility thresholds — identical to filter-derive's (spec "Group-by eligibility").
const MIN_DISTINCT = 2;
const MIN_COVERAGE = 0.2;
const MAX_LARGEST_BUCKET = 0.98;

/** Glyph for a facet group-by chip (a generic "group" mark; the built-ins keep their own). */
const FACET_GLYPH = "◆";

/**
 * Is a groupable facet dimension eligible to be OFFERED as a group-by mode? Mirrors the
 * filter-UI eligibility gate over the columnar index: enough distinct values, enough
 * coverage, and no single value dominating. (A `disabled`-grouping or non-groupable
 * descriptor is filtered out by the caller before this.)
 */
function facetEligible(graph: GraphModel, index: DimensionIndex, key: FacetKey): boolean {
  const total = graph.nodes.length;
  if (total === 0) return false;
  const present = index.present(key);
  if (present.length < MIN_DISTINCT) return false;

  let covered = 0;
  let largest = 0;
  for (let id = 0; id < present.length; id++) {
    largest = Math.max(largest, index.nodesWithValueId(key, id).length);
  }
  for (let ord = 0; ord < total; ord++) {
    if (index.valuesOfOrdinal(ord, key).length > 0) covered++;
  }
  const coverage = covered / total;
  const largestBucketFraction = largest / total;
  return (
    present.length >= MIN_DISTINCT &&
    coverage > MIN_COVERAGE &&
    largestBucketFraction < MAX_LARGEST_BUCKET
  );
}

/**
 * The ordered list of group-by modes to offer for this graph: Directory, Package (only
 * when `hasManifests`), Community, every eligible groupable facet, then None (last — the
 * explicit "no grouping"). Excludes the structural dims that drive Directory/Package
 * directly (folder/kind/language are not offered as generic facet group-bys).
 */
export function deriveGroupByOptions(
  graph: GraphModel,
  catalog: DimensionCatalog,
  index: DimensionIndex,
  hasManifests: boolean,
): GroupByOption[] {
  const out: GroupByOption[] = [{ key: "directory", label: "Directory", glyph: "🗀" }];
  if (hasManifests) out.push({ key: "package", label: "Package", glyph: "▣" });
  out.push({ key: "community", label: "Community", glyph: "⬡" });

  // Structural dims that already drive dedicated modes / have their own UI — never offered
  // as a generic facet group-by.
  const excluded: ReadonlySet<FacetKey> = new Set(["folder", "kind", "language"]);
  for (const d of catalog.descriptors) {
    if (!d.groupable || excluded.has(d.key)) continue;
    if (d.grouping.mode === "disabled") continue; // multi-valued, not groupable
    if (!facetEligible(graph, index, d.key)) continue;
    out.push({ key: `facet:${d.key}`, label: d.label, glyph: FACET_GLYPH });
  }

  out.push({ key: "none", label: "None", glyph: "∅" });
  return out;
}

/** Extract the facet key from a `facet:<key>` group-by modeKey, or null for a built-in. */
export function facetKeyOfGroupBy(modeKey: string): FacetKey | null {
  return modeKey.startsWith("facet:") ? modeKey.slice("facet:".length) : null;
}
