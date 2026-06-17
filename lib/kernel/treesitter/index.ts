// Build a LanguageProvider from a declarative pack, backed by the native
// tree-sitter core. The pack (grammar name + query + import style) is loaded in
// JS; parsing, extraction, and cross-file resolution all happen in Rust, which
// returns the finished graph fragment as JSON.

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
}

/** The file an edge's occurrence lives in — the source node's file (`file#sym` → `file`). */
function fileOf(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
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
      const json = await core.analyze(
        pack.grammar,
        pack.query,
        pack.importStyle,
        JSON.stringify(files),
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
      return { nodes: out.nodes, edges, errors: out.errors };
    },
  };
}
