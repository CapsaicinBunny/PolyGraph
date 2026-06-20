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
