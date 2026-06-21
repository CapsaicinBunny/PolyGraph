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

import { fileLanguage, topFolderOf } from "../graph/filters";
import type { GraphNode } from "../graph/types";
import { matchAnyGlob } from "../glob/match";
import type { NodeSelector } from "../config/schema";

/** Implicit value for a facet key whose value is absent (only `category` today). */
const FACET_DEFAULTS: Record<string, string> = { category: "feature" };

/** Legacy typed field reads, so a node carrying only legacy fields still matches. */
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
function nodeFacetValues(node: GraphNode, key: string): string[] {
  if (key === "kind") return [node.kind];
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
  // value(s) for the key must intersect the selector's values (OR).
  for (const [key, wanted] of Object.entries(selector.facets)) {
    if (wanted.length === 0) continue; // empty constraint → ignored
    const have = nodeFacetValues(node, key);
    if (!wanted.some((w) => have.includes(w))) return false;
  }
  return true;
}
