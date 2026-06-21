// Sparse facet selection — the generic, registry-driven replacement for the
// named filter sets (enabledCategories/Environments/Runtimes/NodeKinds).
//
// The dimension spine filters every dimension uniformly: a `FacetSelection`
// describes which values of one facet are enabled, **sparsely** — no map entry
// for a key means "all values enabled", and "all except one" stores the single
// excluded value rather than thousands of enabled ones (spec "Derivation →
// Filters", review §4). The runtime form uses `Set`; the durable workspace form
// (schema.ts) stores the same shape with `string[]`.

import type { FacetKey, MissingPolicy } from "./dimensions";

/**
 * Which values of one facet are enabled. Sparse:
 *   • `all`     — every value enabled (equivalent to having no entry at all).
 *   • `include` — only the listed values are enabled.
 *   • `exclude` — every value EXCEPT the listed ones is enabled.
 */
export interface FacetSelection {
  mode: "all" | "include" | "exclude";
  values: ReadonlySet<string>;
}

/** Is a single value of a facet enabled under the (possibly absent) selection? */
export function valueEnabled(
  facets: ReadonlyMap<FacetKey, FacetSelection>,
  key: FacetKey,
  value: string,
): boolean {
  const sel = facets.get(key);
  if (!sel || sel.mode === "all") return true;
  if (sel.mode === "include") return sel.values.has(value);
  return !sel.values.has(value); // exclude
}

/**
 * Does a node (carrying `values` for `key`) pass this facet's filter? A node
 * passes iff at least one of its values is enabled (matching the legacy
 * multi-valued "some runtime enabled" gate). When the node carries no value,
 * `MissingPolicy.filter` decides: `exclude` hides it, anything else shows it.
 */
export function facetAllows(
  facets: ReadonlyMap<FacetKey, FacetSelection>,
  key: FacetKey,
  values: readonly string[],
  missing: MissingPolicy["filter"],
): boolean {
  if (values.length === 0) return missing !== "exclude";
  for (const v of values) if (valueEnabled(facets, key, v)) return true;
  return false;
}

/** Set one value's enabled state in a facet's selection, returning the new selection. */
function withValue(sel: FacetSelection | undefined, value: string, on: boolean): FacetSelection {
  // Default (no entry) is "all enabled", modeled as an empty exclude set.
  const mode = sel?.mode === "include" ? "include" : "exclude";
  const values = new Set(sel?.values ?? []);
  if (mode === "exclude") {
    // exclude lists the DISABLED values: disabling adds, enabling removes.
    if (on) values.delete(value);
    else values.add(value);
  } else {
    // include lists the ENABLED values: enabling adds, disabling removes.
    if (on) values.add(value);
    else values.delete(value);
  }
  return { mode, values };
}

/** Drop a now-no-op (all-enabled) selection so the map stays sparse. */
function normalized(
  facets: Map<FacetKey, FacetSelection>,
  key: FacetKey,
  sel: FacetSelection,
): Map<FacetKey, FacetSelection> {
  // An empty exclude set means nothing is disabled ⇒ all enabled ⇒ no entry.
  if (sel.mode === "exclude" && sel.values.size === 0) facets.delete(key);
  else facets.set(key, sel);
  return facets;
}

/**
 * Toggle one value of a facet on/off, returning a NEW sparse map. Disabling a
 * value of an otherwise-all-enabled facet stores just that one value (the
 * "all except one" case); re-enabling the last disabled value clears the entry.
 */
export function toggleFacetValue(
  facets: ReadonlyMap<FacetKey, FacetSelection>,
  key: FacetKey,
  value: string,
): Map<FacetKey, FacetSelection> {
  const next = new Map(facets);
  const currentlyOn = valueEnabled(facets, key, value);
  return normalized(next, key, withValue(facets.get(key), value, !currentlyOn));
}

/** Enable/disable a set of a facet's values at once, returning a NEW sparse map. */
export function setFacetValues(
  facets: ReadonlyMap<FacetKey, FacetSelection>,
  key: FacetKey,
  values: readonly string[],
  on: boolean,
): Map<FacetKey, FacetSelection> {
  const next = new Map(facets);
  let sel = facets.get(key);
  for (const value of values) sel = withValue(sel, value, on);
  return normalized(next, key, sel ?? { mode: "exclude", values: new Set() });
}

/**
 * Whether a selection actually constrains anything — an `all`-mode or
 * empty-`include`-less selection is a no-op equal to having no entry. Used so a
 * canonical signature treats "all enabled" identically however it's spelled.
 */
function constrains(sel: FacetSelection): boolean {
  if (sel.mode === "all") return false;
  if (sel.mode === "include") return true; // an explicit include list always constrains
  return sel.values.size > 0; // exclude with no values is a no-op
}

/**
 * Canonical, order-independent serialization of the whole facet-selection map —
 * for the layout cache signature and the camera fit signature. Keys and values
 * are sorted so `Map` insertion order can't change the string, and no-op
 * selections (mode `all`, or `exclude` with nothing excluded) are dropped so
 * "all enabled" always serializes identically regardless of how it's spelled.
 */
export function serializeFacetSelections(facets: ReadonlyMap<FacetKey, FacetSelection>): string {
  const parts: string[] = [];
  for (const [key, sel] of facets) {
    if (!constrains(sel)) continue;
    const values = [...sel.values].sort().join(",");
    parts.push(`${key}:${sel.mode}:${values}`);
  }
  return parts.sort().join("|");
}
