// A language pack is the declarative definition of a language: a tiny YAML of
// metadata plus a tree-sitter query (tags.scm) using the standard capture
// convention the extractor understands. Adding a language = drop a folder under
// language-packs/<id>/ with pack.yaml + tags.scm; no kernel code changes.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  DimensionDescriptor,
  DimensionValue,
  FacetGrouping,
  MissingPolicy,
} from "../../graph/dimensions";

export interface LanguagePack {
  id: string;
  /** Extensions WITH the leading dot, e.g. [".py"]. */
  extensions: string[];
  /** tree-sitter-wasms grammar name, e.g. "python". */
  grammar: string;
  /** Module-resolution style for import edges, e.g. "python". */
  importStyle: string;
  /** The tree-sitter query source (tags.scm). */
  query: string;
  /**
   * Facet dimensions this pack contributes (the catalog half). Built from the
   * pack.yaml `facets:` block; namespaced keys (e.g. `rust.visibility`). The
   * native core attaches the values per node via `@facet.<key>[.<value>]`
   * captures (see tags.scm); the kernel surfaces these descriptors in
   * `ProviderResult.facetSchema` so the merge namespaces them into the catalog.
   * Empty when the pack declares no facets.
   */
  facetSchema: DimensionDescriptor[];
}

/** One facet value as declared in pack.yaml (label REQUIRED — the handshake). */
interface PackFacetValue {
  value: string;
  label: string;
  color?: string;
  glyph?: string;
}

/**
 * One facet dimension as declared in a pack's `facets:` block. A compact mirror
 * of `DimensionDescriptor`: `dimension` is always `"facet"` and `domain` is
 * always `"closed"` (a pack enumerates the values its captures can emit), so
 * neither is written in YAML. `filterable`/`groupable`/`grouping`/`missing`
 * default sensibly from `cardinality` (single → groupable; multi → grouping
 * disabled) unless overridden.
 */
interface PackFacet {
  key: string;
  label: string;
  cardinality?: "single" | "multi";
  values: PackFacetValue[];
  defaultValue?: string;
  filterable?: boolean;
  groupable?: boolean;
  /** Shorthand for the FacetGrouping mode; defaults from cardinality. */
  grouping?: "single" | "combination" | "disabled" | FacetGrouping;
  missing?: MissingPolicy;
}

interface PackMeta {
  id: string;
  extensions: string[];
  grammar: string;
  imports?: { style?: string };
  queries?: string;
  facets?: PackFacet[];
}

/** Normalize a pack's `grouping:` shorthand into a full `FacetGrouping`. */
function toFacetGrouping(
  grouping: PackFacet["grouping"],
  cardinality: "single" | "multi",
): FacetGrouping {
  if (grouping && typeof grouping === "object") return grouping;
  if (grouping === "combination") return { mode: "combination" };
  if (grouping === "disabled") return { mode: "disabled" };
  if (grouping === "single") return { mode: "single" };
  // Default: single-cardinality is groupable as-is; multi can't pick one group.
  return cardinality === "multi" ? { mode: "disabled" } : { mode: "single" };
}

/**
 * Turn a pack's `facets:` block into provider `DimensionDescriptor`s. Keys stay
 * exactly as authored (already namespaced, e.g. `rust.visibility`), the pack id
 * is the sole `providerId`, and `dimension`/`domain` are fixed (`facet`/`closed`).
 * A facet with no `label`, or a value with no `label`, is an authoring error
 * (the catalog handshake requires labels) and throws so the pack fails loudly.
 */
function buildFacetSchema(meta: PackMeta): DimensionDescriptor[] {
  const facets = meta.facets ?? [];
  return facets.map((facet) => {
    if (!facet.key) throw new Error(`pack "${meta.id}": a facet is missing its "key"`);
    if (!facet.label)
      throw new Error(`pack "${meta.id}": facet "${facet.key}" is missing a "label"`);
    const cardinality = facet.cardinality ?? "single";
    const grouping = toFacetGrouping(facet.grouping, cardinality);
    const values: DimensionValue[] = (facet.values ?? []).map((v) => {
      if (!v.value)
        throw new Error(`pack "${meta.id}": facet "${facet.key}" has a value with no "value"`);
      if (!v.label)
        throw new Error(
          `pack "${meta.id}": facet "${facet.key}" value "${v.value}" is missing a "label"`,
        );
      return { value: v.value, label: v.label, color: v.color, glyph: v.glyph };
    });
    // Multi-valued facets default to non-groupable (containment can't pick one
    // group); single-valued ones are groupable. Either can be overridden.
    const groupable = facet.groupable ?? grouping.mode !== "disabled";
    return {
      key: facet.key,
      label: facet.label,
      dimension: "facet",
      cardinality,
      domain: "closed",
      values,
      providerIds: [meta.id],
      defaultValue: facet.defaultValue,
      filterable: facet.filterable ?? true,
      groupable,
      grouping,
      missing: facet.missing ?? { filter: "include", group: "unclassified" },
    };
  });
}

// POLYGRAPH_PACKS lets a packaged build (the Bun sidecar binary / Tauri app)
// point at the bundled language-packs resource dir; otherwise resolve relative
// to the working directory for local dev and tests. `||` (not `??`) so an empty
// value falls through to the default rather than yielding a broken path.
export function packsDir(): string {
  return process.env.POLYGRAPH_PACKS || join(process.cwd(), "language-packs");
}

export async function loadPack(id: string): Promise<LanguagePack> {
  const dir = join(packsDir(), id);
  const meta = parseYaml(await readFile(join(dir, "pack.yaml"), "utf8")) as PackMeta;
  const query = await readFile(join(dir, meta.queries ?? "tags.scm"), "utf8");
  return {
    id: meta.id,
    extensions: meta.extensions,
    grammar: meta.grammar,
    importStyle: meta.imports?.style ?? meta.id,
    query,
    facetSchema: buildFacetSchema(meta),
  };
}
