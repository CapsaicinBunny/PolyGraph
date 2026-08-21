// A one-shot diagnostic snapshot of a scan result: its shape (counts per kind, catalog
// reach) plus a cheap DATA-INTEGRITY pass over every node. Emitted to the session log on
// each scan so a misbehaving result is diagnosable from the log alone — no reproduction.
//
// The integrity counters are the ones that have actually bitten us: the scan-crash bug
// was a facet value array carrying a null (an analyzer-emitted function/undefined that
// became null over the JSON wire). `nullOrEmptyFacetValues` + `facetKeysWithBadValue`
// make exactly that visible — a non-zero count is a real defect to chase, not noise.

import type { CatalogWarning, DimensionCatalog } from "./dimensions";
import type { GraphModel } from "./types";

export interface ScanIntegrity {
  /** Nodes with a falsy id (should be 0; an id-less node breaks every Map keyed by id). */
  nodesMissingId: number;
  /** Nodes with a falsy kind (should be 0; kind drives styling + the layered UI). */
  nodesMissingKind: number;
  /** Facet values that are null/undefined/"" (should be 0; the scan-crash signature). */
  nullOrEmptyFacetValues: number;
  /** Facet keys that carried at least one bad value, for fast localization. */
  facetKeysWithBadValue: string[];
  /** Edges pointing at an id that isn't in the node set (dangling; should be 0). */
  danglingEdges: number;
}

export interface ScanDiagnostics {
  nodes: number;
  edges: number;
  externals: number;
  /** Node count per kind (file/function/class/external/…). */
  byKind: Record<string, number>;
  /** Descriptor count in the merged catalog (0 ⇒ the TS-only fallback is in play). */
  dimensions: number;
  /** Descriptor keys, so the log shows which languages' facets actually arrived. */
  dimensionKeys: string[];
  /** Non-fatal catalog-merge warnings (undeclared closed values, descriptor conflicts). */
  catalogWarnings: number;
  integrity: ScanIntegrity;
}

/** Compute the scan diagnostics. Pure, single O(nodes + edges) pass; never throws. */
export function scanDiagnostics(
  graph: GraphModel,
  dimensions?: DimensionCatalog,
  catalogWarnings?: CatalogWarning[],
): ScanDiagnostics {
  const byKind: Record<string, number> = {};
  let externals = 0;
  let nodesMissingId = 0;
  let nodesMissingKind = 0;
  let nullOrEmptyFacetValues = 0;
  const badFacetKeys = new Set<string>();
  const ids = new Set<string>();

  for (const n of graph.nodes) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    if (n.kind === "external") externals++;
    if (!n.id) nodesMissingId++;
    else ids.add(n.id);
    if (!n.kind) nodesMissingKind++;
    const facets = n.facets;
    if (facets) {
      for (const key of Object.keys(facets)) {
        const values = facets[key];
        if (!Array.isArray(values)) {
          nullOrEmptyFacetValues++;
          badFacetKeys.add(key);
          continue;
        }
        for (const v of values) {
          if (v == null || v === "") {
            nullOrEmptyFacetValues++;
            badFacetKeys.add(key);
          }
        }
      }
    }
  }

  let danglingEdges = 0;
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) danglingEdges++;
  }

  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    externals,
    byKind,
    dimensions: dimensions?.descriptors.length ?? 0,
    dimensionKeys: dimensions?.descriptors.map((d) => d.key) ?? [],
    catalogWarnings: catalogWarnings?.length ?? 0,
    integrity: {
      nodesMissingId,
      nodesMissingKind,
      nullOrEmptyFacetValues,
      facetKeysWithBadValue: [...badFacetKeys],
      danglingEdges,
    },
  };
}

/** True when the integrity pass found something that should never happen. */
export function hasIntegrityIssue(d: ScanDiagnostics): boolean {
  const i = d.integrity;
  return (
    i.nodesMissingId > 0 ||
    i.nodesMissingKind > 0 ||
    i.nullOrEmptyFacetValues > 0 ||
    i.danglingEdges > 0
  );
}
