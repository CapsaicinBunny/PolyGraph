// The Polymorphic Dimension Spine — serializable foundation (Phase A).
//
// A *Dimension* is any axis you can filter, group, query, or style by. Structural
// ones (kind, language, folder) are universal and derived by the core; facet ones
// (role, category, env, runtime now; per-language later) are provider-contributed.
//
// This module owns the **serializable** half of the model: the durable, JSON-safe
// `DimensionDescriptor` / `DimensionCatalog`, the structural descriptors the core
// always contributes, and the `mergeDescriptors` rules that fold each provider's
// schema into one catalog. The runtime, columnar `DimensionIndex` lives separately
// (dimension-index.ts) and is built from `(graph, catalog)`.
//
// IMPORTANT: this file must NOT import from ./types at runtime — keeping the
// catalog model free of the heavy graph types avoids an import cycle. It needs only
// the structural value sources from ./visual (whose type imports are type-only).

import { FILTERABLE_NODE_KINDS, KIND_GLYPH, NODE_STYLES } from "./visual";

/** A dimension's key, e.g. "role", "env", "kind", "rust.visibility". Namespaced. */
export type FacetKey = string;

/** One value in a dimension's domain, with its display metadata (the handshake). */
export interface DimensionValue {
  value: string;
  label: string;
  color?: string;
  glyph?: string;
}

/**
 * How absent/unclassified nodes are treated — filtering and grouping differ, so
 * the two are split (a node may be shown by the filter yet have no group).
 */
export interface MissingPolicy {
  filter: "include" | "exclude" | "unclassified";
  group: "unclassified" | "exclude";
}

/**
 * A value observed on a node, paired with whether it was declared in a closed
 * descriptor's domain. An undeclared value on a closed dimension surfaces as
 * `declared:false` (the domain stays closed; the data is not lost).
 */
export interface PresentDimensionValue {
  value: string;
  declared: boolean;
}

/**
 * How a multi-valued facet collapses to the single group containment needs. Single
 * cardinality is naturally `single`; multi defaults to `disabled` (filter/query
 * only) unless a provider opts into `primary`/`combination`.
 */
export type FacetGrouping =
  | { mode: "single" } // single-cardinality → groupable as-is
  | { mode: "primary"; choose: "first" | "priority" } // pick one canonical value
  | { mode: "combination" } // value-set → one synthetic group
  | { mode: "disabled" }; // filter/query only (default for multi)

/**
 * The serializable description of one dimension. Travels with `AnalyzeResult` as
 * plain JSON; the UI/CLI/rule engine all build the same runtime index from it.
 */
export interface DimensionDescriptor {
  /** "role", "env", "rust.visibility", "folder", … — namespaced, stable. */
  key: FacetKey;
  /** REQUIRED handshake: a filterable/groupable descriptor with no label is an error. */
  label: string;
  dimension: "structural" | "facet";
  cardinality: "single" | "multi";
  domain: "closed" | "open";
  /** Declared domain values; `[]` for open domains. */
  values: DimensionValue[];
  /** Merged contributors (e.g. ["core","typescript"]). */
  providerIds: string[];
  /** Validated alias onto a core canonical dimension; absent stays namespaced. */
  canonicalKey?: FacetKey;
  /** Implicit value when a node has no entry for this facet (e.g. category → "feature"). */
  defaultValue?: string;
  filterable: boolean;
  groupable: boolean;
  grouping: FacetGrouping;
  missing: MissingPolicy;
}

/** The serializable catalog of all dimensions, durable with `AnalyzeResult`. */
export interface DimensionCatalog {
  descriptors: DimensionDescriptor[];
}

/** A non-fatal issue raised while merging or indexing (e.g. an undeclared value). */
export interface CatalogWarning {
  key: FacetKey;
  value?: string;
  message: string;
}

/**
 * Structural dimensions the core always contributes. `kind` is closed (its domain
 * is the universal node taxonomy); `language` and `folder` are open (derived from
 * file paths at index time). `package` is intentionally deferred (not Phase A).
 */
export const STRUCTURAL_DESCRIPTORS: DimensionDescriptor[] = [
  {
    key: "kind",
    label: "Kind",
    dimension: "structural",
    cardinality: "single",
    domain: "closed",
    values: FILTERABLE_NODE_KINDS.map((kind) => ({
      value: kind,
      label: NODE_STYLES[kind].label,
      color: NODE_STYLES[kind].color,
      glyph: KIND_GLYPH[kind],
    })),
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "exclude", group: "exclude" },
  },
  {
    key: "language",
    label: "Language",
    dimension: "structural",
    cardinality: "single",
    domain: "open",
    values: [],
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "exclude", group: "exclude" },
  },
  {
    key: "folder",
    label: "Folder",
    dimension: "structural",
    cardinality: "single",
    domain: "open",
    values: [],
    providerIds: ["core"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "exclude", group: "exclude" },
  },
];

/** Union two provider-id lists, preserving order and dropping duplicates. */
function unionProviderIds(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const id of b) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Fold one descriptor into an accumulator that already holds an earlier one for the
 * same key. The earlier (core/built-in) descriptor wins metadata; values are
 * unioned by `.value` (first occurrence's metadata wins); a single/multi conflict
 * upgrades cardinality to `multi`; `providerIds` are unioned.
 */
function foldDescriptor(into: DimensionDescriptor, next: DimensionDescriptor): DimensionDescriptor {
  const values = [...into.values];
  const seen = new Set(values.map((v) => v.value));
  for (const v of next.values) {
    if (!seen.has(v.value)) {
      seen.add(v.value);
      values.push(v);
    }
  }
  return {
    ...into, // metadata from the first contributor wins
    values,
    cardinality: into.cardinality === "multi" || next.cardinality === "multi" ? "multi" : "single",
    providerIds: unionProviderIds(into.providerIds, next.providerIds),
  };
}

/**
 * Merge per-provider descriptor lists into one catalog. Lists are processed in
 * order, so the first contributor of a key (typically the core/built-in list) owns
 * its metadata. Returns the catalog plus any warnings raised during the merge.
 */
export function mergeDescriptors(lists: DimensionDescriptor[][]): {
  catalog: DimensionCatalog;
  warnings: CatalogWarning[];
} {
  const byKey = new Map<FacetKey, DimensionDescriptor>();
  const order: FacetKey[] = [];
  const warnings: CatalogWarning[] = [];

  for (const list of lists) {
    for (const descriptor of list) {
      const existing = byKey.get(descriptor.key);
      if (existing) {
        byKey.set(descriptor.key, foldDescriptor(existing, descriptor));
      } else {
        // Copy values so later folds never mutate a caller's array.
        byKey.set(descriptor.key, { ...descriptor, values: [...descriptor.values] });
        order.push(descriptor.key);
      }
    }
  }

  return { catalog: { descriptors: order.map((key) => byKey.get(key)!) }, warnings };
}
