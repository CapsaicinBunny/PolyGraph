// Shared facet-key aliases (spec → Phase D "legacy aliases"; review bug d). Some facet
// keys have a documented legacy/alternate spelling that maps onto the canonical catalog
// key: `environment` is the legacy spelling of the `env` dimension, `lang` of `language`.
//
// These aliases were defined privately inside the query evaluator, so a generic
// `facets: { environment: [...] }` in a config matched/validated in the QUERY language but
// NOT in rule selectors or config validation (which key off the raw, un-aliased name).
// Factoring the map here and applying it consistently in the query evaluator, the rule
// selector (nodeFacetValues), and config validation (validateConfigAgainstIndex) makes the
// documented aliases behave the same everywhere.

import type { FacetKey } from "./dimensions";

/**
 * Documented facet-key aliases → their canonical catalog key. `environment` → `env`,
 * `lang` → `language`. (`role`, `category`, `runtime`, `kind`, `env`, `language` already
 * equal their catalog key and need no alias.)
 */
export const FACET_KEY_ALIASES: Record<string, FacetKey> = {
  environment: "env",
  lang: "language",
};

/**
 * Resolve a (possibly aliased) facet key to its canonical catalog key. An unknown key is
 * returned unchanged — the caller then treats it as a normal (namespaced or structural)
 * key, so this only ever REWRITES the documented aliases and is a no-op otherwise.
 */
export function canonicalFacetKey(key: string): string {
  return FACET_KEY_ALIASES[key] ?? key;
}
