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

  const buckets = new Map<LanguageProvider, SourceFileMap>();
  for (const [path, text] of Object.entries(files)) {
    const ext = extensionOf(path);
    const provider = providers.find((p) => p.extensions.includes(ext));
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
  for (const r of results) {
    nodes.push(...r.nodes);
    edges.push(...r.edges);
    errors.push(...r.errors);
  }

  const dedupedNodes = dedupeById(nodes);
  const nodeIds = new Set(dedupedNodes.map((n) => n.id));
  const validEdges = dedupeById(edges).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return { graph: { nodes: dedupedNodes, edges: validEdges }, errors };
}
