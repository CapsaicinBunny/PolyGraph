// Dual-write bridge for the dimension-spine migration (Phase A).
//
// Every facet write routes through `writeFacet`, which keeps the legacy typed
// field (`role`/`category`/`environment`/`runtimes`) and the generic
// `node.facets[key]` in lock-step. Per the "no low-information facets" rule, a
// value equal to the descriptor's default (only `category: "feature"` today) is
// mirrored to the legacy field but NOT materialized as a facet — so the ubiquitous
// default never bloats storage. A graph-wide parity invariant
// (`facetParityMismatches`) asserts legacy ≡ facets-or-default for every node
// throughout Phases A–C.

import type { Environment, GraphNode, NodeCategory, NodeRole, Runtime } from "./types";

/**
 * Implicit value for a facet whose key is absent from `node.facets`. Only
 * `category` has a default today (`"feature"` is ubiquitous and never stored).
 */
export const FACET_DEFAULTS: Record<string, string> = {
  category: "feature",
};

/** Facet keys whose legacy field differs from the key, and whether it is array-typed. */
type LegacyField = "role" | "category" | "environment" | "runtimes";

/** Map a facet key to its legacy GraphNode field name. */
const LEGACY_FIELD: Record<string, LegacyField> = {
  role: "role",
  category: "category",
  env: "environment",
  runtime: "runtimes",
};

/** Mirror the legacy typed field for a facet key from its string value(s). */
function writeLegacy(node: GraphNode, key: string, values: string[]): void {
  const field = LEGACY_FIELD[key];
  if (!field) return;
  if (field === "runtimes") {
    node.runtimes = values as Runtime[];
  } else if (field === "role") {
    node.role = values[0] as NodeRole;
  } else if (field === "category") {
    node.category = values[0] as NodeCategory;
  } else {
    node.environment = values[0] as Environment;
  }
}

/**
 * Write a facet onto a node, dual-writing the legacy field and `node.facets[key]`.
 * The legacy field is always mirrored; the facet is materialized only when
 * informative — i.e. NOT when the value is exactly the descriptor's default
 * (so `category: "feature"` is never stored). Empty `values` is a no-op.
 */
export function writeFacet(node: GraphNode, key: string, values: string[]): void {
  // Drop null/undefined/"" values at the single storage chokepoint. A provider that
  // emits an undefined (e.g. a runtime it could not classify) must never persist it:
  // JSON.stringify turns an array-`undefined` into `null` across the worker/sidecar
  // boundary, and a null "value" then crashes value-keyed styling on the client.
  const clean = values.filter((v) => v != null && v !== "");
  if (clean.length === 0) return;

  writeLegacy(node, key, clean);

  const isDefault = clean.length === 1 && clean[0] === FACET_DEFAULTS[key];
  if (isDefault) {
    // The default is never materialized; clear any earlier non-default facet for
    // this key so the facet never lags behind the (just-updated) legacy field.
    if (node.facets) delete node.facets[key];
    return;
  }

  (node.facets ??= {})[key] = clean;
}

/** The string value(s) a node carries for a facet, resolving absence to the default. */
function facetValues(node: GraphNode, key: string): string[] {
  const stored = node.facets?.[key];
  if (stored) return stored;
  const def = FACET_DEFAULTS[key];
  return def !== undefined ? [def] : [];
}

/** The legacy field's value(s) for a facet key, as a string array (empty if unset). */
function legacyValues(node: GraphNode, key: string): string[] {
  if (key === "runtime") return node.runtimes ?? [];
  if (key === "role") return node.role ? [node.role] : [];
  if (key === "category") return [node.category ?? FACET_DEFAULTS.category];
  if (key === "env") return node.environment ? [node.environment] : [];
  return [];
}

function sameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Compare each dual-written facet against its legacy field (resolving absent
 * facets to their default). Returns the keys that disagree — empty when the node's
 * legacy fields and facets are in sync (the parity invariant).
 */
export function facetParityMismatches(node: GraphNode): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(LEGACY_FIELD)) {
    if (!sameValues(legacyValues(node, key), facetValues(node, key))) mismatches.push(key);
  }
  return mismatches;
}
