// Match a single graph node against a normalized NodeSelector. Facets present in
// the selector are AND-ed; entries within a facet are OR-ed. A facet that is
// empty is simply ignored (it places no constraint).
//
// Matching is generic (Phase D): the selector's `facets` store is keyed by
// canonical dimension key (`kind`, `role`, `env`, `category`, `rust.visibility`, …)
// and a node's value(s) for a key are resolved registry-free — structural keys
// from the node/path, facet keys from `node.facets` with a legacy-field/default
// fallback so legacy-only nodes still match. The loader mirrors the legacy typed
// selector fields into `facets`, so this one path covers both old and new configs.

import { canonicalFacetKey } from "../graph/facet-aliases";
import { FACET_DEFAULTS } from "../graph/facets-write";
import { canonicalLanguageKey, fileLanguage, topFolderOf } from "../graph/filters";
import type { GraphNode } from "../graph/types";
import { matchAnyGlob } from "../glob/match";
import type { NodeSelector } from "../config/schema";

/**
 * Legacy typed field reads, so a node carrying only legacy fields still matches.
 * DEFERRED removal (Phase E): non-TS providers don't yet populate `node.facets`, so
 * this fallback is load-bearing for legacy-only nodes. It retires with the legacy
 * GraphNode fields once every provider writes facets (see GraphNode in graph/types.ts).
 */
function legacyFacetValues(node: GraphNode, key: string): string[] {
  switch (key) {
    case "role":
      return node.role ? [node.role] : [];
    case "env":
      return node.environment ? [node.environment] : [];
    case "category":
      return node.category ? [node.category] : [];
    case "runtime":
      return node.runtimes ?? [];
    default:
      return [];
  }
}

/**
 * The string value(s) a node carries for a canonical dimension key, registry-free.
 * Structural keys derive from the node/path; facet keys read `node.facets`, then
 * the legacy typed field, then the descriptor default — so the result is stable
 * whether a node was written via `writeFacet` or with legacy fields only.
 */
function nodeFacetValues(node: GraphNode, rawKey: string): string[] {
  // Resolve documented aliases (environment→env, lang→language) so a config using the
  // query spelling matches here too — the same resolution the query evaluator applies.
  const key = canonicalFacetKey(rawKey);
  if (key === "kind") return [node.kind];
  // The structural `language` value space is the badge code (e.g. "RS"). Selector
  // values are canonicalized to the same space in `matchNode`, so a config may use
  // either a human name ("rust") or the code ("RS"), matching the query language.
  if (key === "language") return [fileLanguage(node.filePath).key];
  if (key === "folder") return [topFolderOf(node.filePath)];
  const stored = node.facets?.[key];
  if (stored && stored.length > 0) return stored;
  const legacy = legacyFacetValues(node, key);
  if (legacy.length > 0) return legacy;
  const def = FACET_DEFAULTS[key];
  return def !== undefined ? [def] : [];
}

export function matchNode(selector: NodeSelector, node: GraphNode): boolean {
  if (selector.paths.length > 0 && !matchAnyGlob(selector.paths, node.filePath)) return false;
  // Generic facet store: every key with values must be satisfied (AND); a node's
  // value(s) for the key must intersect the selector's values (OR). The `language`
  // key compares in the canonical badge-code space (human names mapped, lowercased)
  // so a selector value of "rust" matches an "RS" node — consistent with the query.
  for (const [rawKey, wanted] of Object.entries(selector.facets)) {
    if (wanted.length === 0) continue; // empty constraint → ignored
    // Resolve documented aliases so the language branch (and value resolution) fire for the
    // aliased spelling too (e.g. `lang` → `language`).
    const key = canonicalFacetKey(rawKey);
    const have = nodeFacetValues(node, rawKey);
    const matched =
      key === "language"
        ? have.some((h) => {
            const hv = canonicalLanguageKey(h);
            return wanted.some((w) => canonicalLanguageKey(w) === hv);
          })
        : wanted.some((w) => have.includes(w));
    if (!matched) return false;
  }
  return true;
}
