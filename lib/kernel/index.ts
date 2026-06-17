// The language-agnostic analysis kernel. Buckets files by the provider that
// claims their extension, runs each provider, then merges the universal-IR
// fragments — de-duplicating nodes/edges and dropping edges to unknown nodes.
// This is the multi-language entry point used by the API route; the TS-only
// analyzeSources remains for the TypeScript provider and its tests.

import type {
  AnalyzeError,
  AnalyzeResult,
  GraphEdge,
  GraphNode,
  SourceFileMap,
  UnresolvedRef,
} from "../graph/types";
import type { PackageDeps } from "../server/package-deps";
import type { LanguageProvider } from "./provider";
import { getProviders } from "./registry";

export interface AnalyzeProjectOptions {
  packages?: PackageDeps;
}

function extensionOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
  return [...byId.values()];
}

/** Analyze a multi-language source map into a single graph via the provider plugins. */
export async function analyzeProject(
  files: SourceFileMap,
  options: AnalyzeProjectOptions = {},
): Promise<AnalyzeResult> {
  const providers = await getProviders();

  // Precompute ext -> provider once so per-file lookup is O(1) instead of an
  // O(providers) scan. Preserve find()'s semantics: the first provider (in
  // registry order) that claims an extension wins, so only set keys not already
  // present.
  const providerByExt = new Map<string, LanguageProvider>();
  for (const p of providers) {
    for (const ext of p.extensions) {
      if (!providerByExt.has(ext)) providerByExt.set(ext, p);
    }
  }

  const buckets = new Map<LanguageProvider, SourceFileMap>();
  for (const [path, text] of Object.entries(files)) {
    const ext = extensionOf(path);
    const provider = providerByExt.get(ext);
    if (!provider) continue;
    let bucket = buckets.get(provider);
    if (!bucket) {
      bucket = {};
      buckets.set(provider, bucket);
    }
    bucket[path] = text;
  }

  const ctx = { packages: options.packages };
  const results = await Promise.all(
    [...buckets.entries()].map(async ([provider, bucket]) => {
      try {
        return await provider.analyze(bucket, ctx);
      } catch (e) {
        // A single provider failing (e.g. a malformed pack query) must not sink
        // the rest of the analysis — surface it as an error and move on.
        return {
          nodes: [],
          edges: [],
          errors: [
            { filePath: `<${provider.id}>`, message: e instanceof Error ? e.message : String(e) },
          ],
        };
      }
    }),
  );

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const errors: AnalyzeError[] = [];
  const unresolved: UnresolvedRef[] = [];
  // Append with loops, not `push(...arr)` — spreading a huge array as call
  // arguments overflows the engine's argument limit ("Maximum call stack size
  // exceeded") on very large codebases.
  for (const r of results) {
    for (const n of r.nodes) nodes.push(n);
    for (const e of r.edges) edges.push(e);
    for (const er of r.errors) errors.push(er);
    if (r.unresolved) for (const u of r.unresolved) unresolved.push(u);
  }

  const dedupedNodes = dedupeById(nodes);
  const nodeIds = new Set(dedupedNodes.map((n) => n.id));
  const validEdges = dedupeById(edges).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return { graph: { nodes: dedupedNodes, edges: validEdges }, errors, unresolved };
}
