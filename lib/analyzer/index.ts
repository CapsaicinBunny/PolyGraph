import type {
  AnalyzeError,
  AnalyzeResult,
  GraphEdge,
  GraphModel,
  GraphNode,
  SourceFileMap,
} from "../graph/types";
import { mergeEvidence } from "../graph/types";
import { analyzeCalls } from "./calls";
import { analyzeComponents } from "./components";
import { analyzeComposition } from "./composition";
import { analyzeExternals } from "./externals";
import { analyzeImports } from "./imports";
import { analyzeInheritance } from "./inheritance";
import { buildDeclIndex } from "./nodes";
import type { PackageDeps } from "../server/package-deps";
import { createInMemoryProject, toRelativePath } from "./project";

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  return [...byId.values()];
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const byId = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const existing = byId.get(edge.id);
    // Merge evidence when two analyzers emit the same edge id, rather than dropping.
    if (existing) mergeEvidence(existing, edge);
    else byId.set(edge.id, { ...edge, occurrences: [...edge.occurrences] });
  }
  // Dropping edges with unknown endpoints is handled by callers via the node set;
  // here we only de-duplicate (merging evidence).
  return [...byId.values()];
}

export interface AnalyzeOptions {
  /** Declared dependencies (from package.json) used to enrich npm external nodes. */
  packages?: PackageDeps;
}

// Memoize the (expensive) ts-morph analysis by a content hash, so re-scanning the
// same unchanged sources returns instantly.
const ANALYSIS_CACHE_MAX = 8;
const analysisCache = new Map<string, AnalyzeResult>();

/** cyrb53 fold over many strings without building one giant concatenation. */
function hashParts(parts: Iterable<string>): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const str of parts) {
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    // separator so ["ab","c"] != ["a","bc"]
    h1 = Math.imul(h1 ^ 0, 2654435761);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function analysisSignature(files: SourceFileMap, options: AnalyzeOptions): string {
  const parts: string[] = [];
  for (const path of Object.keys(files).sort()) {
    parts.push(path, files[path]);
  }
  const packages = options.packages ?? {};
  for (const name of Object.keys(packages).sort()) {
    parts.push("", name, packages[name].version, packages[name].type);
  }
  return `${Object.keys(files).length}:${hashParts(parts)}`;
}

/**
 * Analyze a map of source files into a graph model. Files that fail to parse are
 * collected into `errors` and skipped; the rest still produce a graph. Memoized by
 * a content hash of the inputs.
 */
export function analyzeSources(files: SourceFileMap, options: AnalyzeOptions = {}): AnalyzeResult {
  const signature = analysisSignature(files, options);
  const cached = analysisCache.get(signature);
  if (cached) {
    analysisCache.delete(signature);
    analysisCache.set(signature, cached);
    return cached;
  }

  const errors: AnalyzeError[] = [];
  const project = createInMemoryProject(files);

  // Surface parse errors per file without aborting the whole analysis. Some files
  // (e.g. extracted .vue/.svelte scripts under a non-TS extension) can make the TS
  // diagnostics pass throw, so guard each file independently.
  for (const file of project.getSourceFiles()) {
    let diagnostics: ReturnType<typeof file.getPreEmitDiagnostics> = [];
    try {
      diagnostics = file.getPreEmitDiagnostics?.() ?? [];
    } catch {
      continue;
    }
    for (const d of diagnostics) {
      // Only report genuine syntax errors (category 1), not type errors.
      if (d.getCategory() === 1 && d.getCode() >= 1000 && d.getCode() < 2000) {
        errors.push({
          filePath: toRelativePath(file.getFilePath()),
          message:
            typeof d.getMessageText() === "string" ? (d.getMessageText() as string) : "Parse error",
        });
      }
    }
  }

  const index = buildDeclIndex(project);
  const externals = analyzeExternals(project, index, options.packages);
  const imports = analyzeImports(project);

  const edges: GraphEdge[] = [
    ...imports.edges,
    ...analyzeCalls(project, index),
    ...analyzeInheritance(project, index),
    ...analyzeComponents(project, index),
    ...analyzeComposition(project, index),
    ...externals.edges,
  ];

  const nodes = dedupeNodes([...index.nodes, ...externals.nodes]);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = dedupeEdges(edges).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  const graph: GraphModel = { nodes, edges: validEdges };
  const result: AnalyzeResult = { graph, errors, unresolved: imports.unresolved };

  analysisCache.set(signature, result);
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  return result;
}
