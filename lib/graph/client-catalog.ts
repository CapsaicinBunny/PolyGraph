// The catalog the client/UI builds its DimensionIndex from.
//
// The multi-language kernel ships a merged `DimensionCatalog` on
// `AnalyzeResult.dimensions`; the TS-only `analyzeSources` path omits it. So the
// client takes `result.dimensions` when present, else falls back to the same
// merge the kernel would have produced for a TS/JS project (structural + the TS
// provider's facets) — guaranteeing role/category/env/runtime still surface as
// filter sections on the TS-only path ("and more" = provider facets appear
// automatically).

import { TS_FACET_DESCRIPTORS } from "../analyzer/facet-schema";
import {
  type DimensionCatalog,
  type FacetKey,
  mergeDescriptors,
  STRUCTURAL_DESCRIPTORS,
} from "./dimensions";

/** The facet keys the TS provider contributes — the fallback "and more" filters. */
export const FILTER_FACET_FALLBACK_KEYS: ReadonlySet<FacetKey> = new Set(
  TS_FACET_DESCRIPTORS.map((d) => d.key),
);

let cachedFallback: DimensionCatalog | undefined;

/** The default TS/JS catalog (structural + TS facets), merged once and reused. */
function fallbackCatalog(): DimensionCatalog {
  if (!cachedFallback) {
    cachedFallback = mergeDescriptors([STRUCTURAL_DESCRIPTORS, TS_FACET_DESCRIPTORS]).catalog;
  }
  return cachedFallback;
}

/** The catalog to index by: the result's own, or the TS/JS fallback. */
export function clientCatalog(provided: DimensionCatalog | undefined): DimensionCatalog {
  return provided ?? fallbackCatalog();
}
