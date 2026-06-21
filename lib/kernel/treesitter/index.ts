// Build a LanguageProvider from a declarative pack, backed by the native
// tree-sitter core. The pack (grammar name + query + import style) is loaded in
// JS; parsing, extraction, and cross-file resolution all happen in Rust, which
// returns the finished graph fragment as JSON.

import type { DimensionDescriptor } from "../../graph/dimensions";
import type { AnalyzeError, EdgeConfidence, GraphEdge, GraphNode } from "../../graph/types";
import type { LanguageProvider, ProviderResult } from "../provider";
import { type AnalyzerCore, loadCore } from "./core";
import { loadPack } from "./pack";

// The native core emits each edge with the 1-based location + confidence of the
// reference it came from; the kernel adds the occurrence's filePath (from the edge
// source) and the provider (the language pack id).
type CoreEdge = Omit<GraphEdge, "occurrences" | "count"> & {
  line: number;
  column: number;
  confidence: EdgeConfidence;
};

interface CoreOutput {
  nodes: GraphNode[];
  edges: CoreEdge[];
  errors: AnalyzeError[];
  /** The pack's facet catalog, echoed by the core; omitted for facet-less packs. */
  facetSchema?: DimensionDescriptor[];
}

/** The file an edge's occurrence lives in — the source node's file (`file#sym` → `file`). */
function fileOf(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
}

/**
 * Strip null/undefined/"" values from every node's facets, in place. The native core
 * can emit a facet key whose capture resolved to nothing (e.g. an unclassifiable
 * `@facet.runtime` on generated/wasm-bindgen code), which serializes as `null`. Left
 * in, that null interns as a dimension "value" and crashes value-keyed styling once
 * JSON crosses the worker/sidecar boundary. Only rewrites nodes that actually carry a
 * bad value, so the clean hot path stays allocation-free.
 */
function sanitizeNodeFacets(nodes: GraphNode[]): void {
  for (const node of nodes) {
    const facets = node.facets;
    if (!facets) continue;
    for (const key of Object.keys(facets)) {
      const values = facets[key];
      if (!values.some((v) => v == null || v === "")) continue;
      const clean = values.filter((v) => v != null && v !== "");
      if (clean.length) facets[key] = clean;
      else delete facets[key];
    }
  }
}

export async function createTreeSitterProvider(packId: string): Promise<LanguageProvider> {
  const pack = await loadPack(packId);
  // Fail fast here if the native core is missing so the registry can fall back.
  const core: AnalyzerCore = loadCore();

  return {
    id: pack.id,
    extensions: pack.extensions,
    // The native core now runs the parse off the JS thread and returns a
    // Promise, so this is async and we await it. That's what lets the kernel's
    // `Promise.all` over buckets parse different languages concurrently instead
    // of freezing Bun on one synchronous multi-minute call.
    async analyze(files: Record<string, string>): Promise<ProviderResult> {
      // The pack's facet schema (from pack.yaml) goes in so the core knows which
      // `@facet.<key>` captures are real facets; it comes back unchanged on
      // `out.facetSchema`. Pass "" when the pack declares none.
      const facetSchemaJson = pack.facetSchema.length ? JSON.stringify(pack.facetSchema) : "";
      const json = await core.analyze(
        pack.grammar,
        pack.query,
        pack.importStyle,
        JSON.stringify(files),
        facetSchemaJson,
      );
      const out = JSON.parse(json) as CoreOutput;
      const edges: GraphEdge[] = out.edges.map((e) => {
        const { line, column, confidence, ...edge } = e;
        return {
          ...edge,
          occurrences: [
            { filePath: fileOf(edge.source), line, column, provider: pack.id, confidence },
          ],
          count: 1,
        };
      });
      // Surface the pack's facet descriptors so the kernel merge namespaces them
      // into AnalyzeResult.dimensions (the catalog handshake). Prefer the schema
      // the core echoed; fall back to the pack's own (identical) copy so the
      // facetSchema is present even if an older core didn't echo it.
      const facetSchema =
        out.facetSchema ?? (pack.facetSchema.length ? pack.facetSchema : undefined);
      sanitizeNodeFacets(out.nodes);
      return { nodes: out.nodes, edges, errors: out.errors, facetSchema };
    },
  };
}
