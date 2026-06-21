// Workspace facet-selection migration (Phase B task 5).
//
// The durable workspace stores facet selections as JSON (`FacetSelectionState`,
// values as `string[]`); the live Explorer state uses the runtime
// `FacetSelection` (values as `Set`). This module converts between them
// and migrates the LEGACY named arrays (enabledNodeKinds/Categories/
// Environments/Runtimes) — which were the *enabled* value lists — into the
// generic `enabledFacets` map, so old workspaces still load with identical
// filtering.

import type { FacetKey } from "../graph/dimensions";
import type { FacetSelection } from "../graph/facet-selection";

/** Durable (JSON) form of one facet selection — the runtime `Set` becomes an array. */
export interface FacetSelectionState {
  mode: "all" | "include" | "exclude";
  values: string[];
}

/** Legacy → generic key mapping for the four named filter arrays. */
const LEGACY_ARRAY_TO_KEY: Record<string, FacetKey> = {
  enabledNodeKinds: "kind",
  enabledCategories: "category",
  enabledEnvironments: "env",
  enabledRuntimes: "runtime",
};

/** Whether a selection actually constrains (an `all` / empty-`exclude` is a no-op). */
function constrains(sel: FacetSelection): boolean {
  if (sel.mode === "all") return false;
  if (sel.mode === "include") return true;
  return sel.values.size > 0;
}

/** Runtime selection map → durable JSON record (sorted; no-op selections dropped). */
export function facetSelectionsToState(
  facets: ReadonlyMap<FacetKey, FacetSelection>,
): Record<FacetKey, FacetSelectionState> {
  const out: Record<FacetKey, FacetSelectionState> = {};
  for (const [key, sel] of facets) {
    if (!constrains(sel)) continue;
    out[key] = { mode: sel.mode, values: [...sel.values].sort() };
  }
  return out;
}

/** Durable JSON record → runtime selection map (arrays become Sets). */
export function facetStateToSelections(
  state: Record<FacetKey, FacetSelectionState>,
): Map<FacetKey, FacetSelection> {
  const out = new Map<FacetKey, FacetSelection>();
  for (const [key, s] of Object.entries(state)) {
    out.set(key, { mode: s.mode, values: new Set(s.values) });
  }
  return out;
}

/** The legacy/new filter fields a workspace may carry, for migration. */
export interface LegacyFilterFields {
  enabledFacets?: Record<FacetKey, FacetSelectionState>;
  enabledNodeKinds?: string[];
  enabledCategories?: string[];
  enabledEnvironments?: string[];
  enabledRuntimes?: string[];
}

/**
 * Resolve a workspace's facet selections: the new `enabledFacets` map when
 * present, else the legacy named arrays converted to `include`-mode selections
 * (an old "enabled X,Y" list means only X,Y pass — exactly the old behavior).
 */
export function migrateLegacyEnabledFacets(
  f: LegacyFilterFields,
): Record<FacetKey, FacetSelectionState> {
  if (f.enabledFacets) return f.enabledFacets;
  const out: Record<FacetKey, FacetSelectionState> = {};
  for (const [arrayName, key] of Object.entries(LEGACY_ARRAY_TO_KEY)) {
    const values = f[arrayName as keyof LegacyFilterFields] as string[] | undefined;
    if (Array.isArray(values)) out[key] = { mode: "include", values: [...values].sort() };
  }
  return out;
}
