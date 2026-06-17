// The language-plugin boundary. A provider receives the subset of files whose
// extension it claims and emits fragments of the universal graph IR. How it
// resolves references is up to the provider: the TypeScript provider uses
// ts-morph's type checker (precise); tree-sitter packs use name/scope/import
// heuristics (declarative, easy to add). The kernel just merges the results, so
// a language can start as a declarative pack and later graduate to a precise
// code-backed provider without changing anything else.

import type { AnalyzeError, GraphEdge, GraphNode, UnresolvedRef } from "../graph/types";
import type { PackageDeps } from "../server/package-deps";

export interface ProviderContext {
  /** Declared dependencies (package.json), used to enrich npm external nodes. */
  packages?: PackageDeps;
}

export interface ProviderResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: AnalyzeError[];
  /** References that resolved to nothing; providers that don't track this omit it. */
  unresolved?: UnresolvedRef[];
}

export interface LanguageProvider {
  /** Stable id, e.g. "typescript" or "python". */
  id: string;
  /** Lowercase file extensions WITH the leading dot, e.g. [".py"]. */
  extensions: string[];
  /** Analyze this provider's files into universal-IR fragments. */
  analyze(
    files: Record<string, string>,
    ctx: ProviderContext,
  ): ProviderResult | Promise<ProviderResult>;
}
