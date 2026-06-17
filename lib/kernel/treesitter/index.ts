// Build a LanguageProvider from a declarative pack, backed by the native
// tree-sitter core. The pack (grammar name + query + import style) is loaded in
// JS; parsing, extraction, and cross-file resolution all happen in Rust, which
// returns the finished graph fragment as JSON.

import type { AnalyzeError, GraphEdge, GraphNode } from "../../graph/types";
import type { LanguageProvider, ProviderResult } from "../provider";
import { type AnalyzerCore, loadCore } from "./core";
import { loadPack } from "./pack";

// The native core emits edges without evidence fields; Phase 1 fills them with
// honest placeholders ("not captured yet"). Phase 3 will emit real evidence.
type CoreEdge = Omit<GraphEdge, "occurrences" | "count">;

interface CoreOutput {
  nodes: GraphNode[];
  edges: CoreEdge[];
  errors: AnalyzeError[];
}

export async function createTreeSitterProvider(packId: string): Promise<LanguageProvider> {
  const pack = await loadPack(packId);
  // Fail fast here if the native core is missing so the registry can fall back.
  const core: AnalyzerCore = loadCore();

  return {
    id: pack.id,
    extensions: pack.extensions,
    analyze(files: Record<string, string>): ProviderResult {
      const json = core.analyze(pack.grammar, pack.query, pack.importStyle, JSON.stringify(files));
      const out = JSON.parse(json) as CoreOutput;
      const edges: GraphEdge[] = out.edges.map((e) => ({ ...e, occurrences: [], count: 0 }));
      return { nodes: out.nodes, edges, errors: out.errors };
    },
  };
}
