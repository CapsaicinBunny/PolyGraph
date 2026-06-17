import type {
  AnalyzeError,
  AnalyzeResult,
  GraphEdge,
  GraphNode,
  SourceFileMap,
  UnresolvedRef,
} from "../graph/types";
import { fileNodeId, makeEdge, mergeEvidence } from "../graph/types";
import { analyzeCalls } from "./calls";
import { analyzeComponents } from "./components";
import { analyzeComposition } from "./composition";
import { analyzeExternals } from "./externals";
import { analyzeImports } from "./imports";
import { analyzeInheritance } from "./inheritance";
import { buildDeclIndex } from "./nodes";
import type { PackageDeps } from "../server/package-deps";
import {
  batchPathsByDirectory,
  createInMemoryProject,
  resolveModuleSpecifier,
  toRelativePath,
} from "./project";

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
  /**
   * File-count above which analysis is split into directory batches to bound
   * memory (one ts-morph Project is built and dropped per batch instead of
   * holding every AST + the checker's caches at once). Defaults to
   * {@link DEFAULT_BATCH_THRESHOLD}. Below the threshold, behavior is identical
   * to a single-project analysis. Exposed primarily so tests can force batching
   * without a huge fixture.
   */
  batchThreshold?: number;
  /**
   * Target number of files per batch when batching is active. Defaults to
   * {@link DEFAULT_BATCH_SIZE}. Files are grouped by directory, so a batch may
   * be smaller (or, for an oversized directory, larger) than this.
   */
  batchSize?: number;
}

/**
 * Default file count above which {@link analyzeSources} switches to memory-bounded
 * batching. Tuned to keep normal repositories on the single-project fast path
 * (byte-identical output) while protecting against OOM on huge trees
 * (e.g. linux/drivers).
 */
export const DEFAULT_BATCH_THRESHOLD = 8000;

/** Default target files per batch once batching is active. */
export const DEFAULT_BATCH_SIZE = 3000;

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
  // Batching options change the output (cross-batch type-resolved edges may
  // differ), so they must be part of the cache key.
  parts.push(" batch", String(options.batchThreshold ?? ""), String(options.batchSize ?? ""));
  return `${Object.keys(files).length}:${hashParts(parts)}`;
}

/** Raw graph fragment from one ts-morph Project, before the final dedupe/merge. */
interface AnalysisFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
  errors: AnalyzeError[];
  unresolved: UnresolvedRef[];
}

/**
 * Run the full analysis over a single in-memory ts-morph Project built from
 * `files`, returning the raw (un-deduped) graph fragment.
 *
 * The analysis passes run inside `project.forgetNodesCreatedInBlock(...)`: every
 * ts-morph node wrapper created while walking the ASTs is released the moment the
 * block returns. This frees the (large) JS-side wrapped-node cache before we hand
 * back plain graph data, with NO effect on output — the underlying TypeScript
 * program and its checker results are untouched; only ts-morph's lazily-built
 * JS wrappers are forgotten. This is the low-risk memory win.
 */
function analyzeProject(files: SourceFileMap, options: AnalyzeOptions): AnalysisFragment {
  const project = createInMemoryProject(files);

  return project.forgetNodesCreatedInBlock(() => {
    const errors: AnalyzeError[] = [];

    // Surface parse errors per file without aborting the whole analysis. We use the
    // program's *syntactic* diagnostics (the parser's own errors) rather than
    // getPreEmitDiagnostics(), which type-checks the entire program on every call —
    // turning this into an O(whole-program) cost repeated per file. Syntactic
    // diagnostics need zero type checking yet surface the exact same syntax errors
    // (category 1, codes 1000-1999). Some files (e.g. extracted .vue/.svelte scripts
    // under a non-TS extension) can make the diagnostics pass throw, so guard each
    // file independently.
    const program = project.getProgram();
    for (const file of project.getSourceFiles()) {
      let diagnostics: ReturnType<typeof program.getSyntacticDiagnostics> = [];
      try {
        diagnostics = program.getSyntacticDiagnostics(file);
      } catch {
        continue;
      }
      for (const d of diagnostics) {
        // Only report genuine syntax errors (category 1), not type errors.
        if (d.getCategory() === 1 && d.getCode() >= 1000 && d.getCode() < 2000) {
          errors.push({
            filePath: toRelativePath(file.getFilePath()),
            message:
              typeof d.getMessageText() === "string"
                ? (d.getMessageText() as string)
                : "Parse error",
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

    return {
      nodes: [...index.nodes, ...externals.nodes],
      edges,
      errors,
      unresolved: imports.unresolved,
    };
  });
}

/**
 * Structurally resolve every static `import`/`export … from` specifier across the
 * full file set into module-level import edges, without a type checker. Used in
 * batch mode so that an import whose target lives in a *different* batch (and is
 * therefore invisible to that batch's checker) still produces an import edge — the
 * import backbone must stay complete across batch boundaries.
 *
 * Returns the edges plus, for each importing file, the set of specifier strings
 * that resolved — so the caller can drop those from per-batch "unresolved" lists
 * (a cross-batch import is resolved here, not genuinely missing).
 */
function structuralImportEdges(files: SourceFileMap): {
  edges: GraphEdge[];
  resolvedSpecs: Map<string, Set<string>>;
} {
  const fileSet = new Set(Object.keys(files));
  const edges: GraphEdge[] = [];
  const resolvedSpecs = new Map<string, Set<string>>();

  // Match `import ... from "spec"`, `export ... from "spec"`, and bare
  // `import "spec"` / `export * from "spec"` module specifiers. Comments are not
  // stripped, but a false positive can only resolve to a real project file, so at
  // worst it confirms an edge that the checker also produces.
  const fromRe = /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g;
  const sideEffectRe = /\bimport\s*["'`]([^"'`]+)["'`]/g;

  for (const [path, text] of Object.entries(files)) {
    const source = fileNodeId(path);
    let matched: Set<string> | undefined;

    const consider = (spec: string): void => {
      const target = resolveModuleSpecifier(spec, path, fileSet);
      if (!target) return;
      if (!matched) {
        matched = new Set();
        resolvedSpecs.set(path, matched);
      }
      matched.add(spec);
      const dest = fileNodeId(target);
      if (source === dest) return;
      // Structural (path-based) resolution — no evidence occurrences; per-batch
      // checker edges (with occurrences) merge over these via dedupeEdges.
      edges.push(makeEdge(source, dest, "import"));
    };

    for (const m of text.matchAll(fromRe)) consider(m[1]);
    for (const m of text.matchAll(sideEffectRe)) consider(m[1]);
  }

  return { edges, resolvedSpecs };
}

/**
 * Assemble the final graph from one or more raw fragments: concatenate nodes and
 * edges, dedupe (merging edge evidence), and drop edges whose endpoints aren't in
 * the node set.
 */
function assembleResult(
  fragments: AnalysisFragment[],
  extraEdges: GraphEdge[],
  unresolved: UnresolvedRef[],
): AnalyzeResult {
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [...extraEdges];
  const errors: AnalyzeError[] = [];
  for (const frag of fragments) {
    allNodes.push(...frag.nodes);
    allEdges.push(...frag.edges);
    errors.push(...frag.errors);
  }

  const nodes = dedupeNodes(allNodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = dedupeEdges(allEdges).filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return { graph: { nodes, edges: validEdges }, errors, unresolved };
}

/**
 * Analyze a map of source files into a graph model. Files that fail to parse are
 * collected into `errors` and skipped; the rest still produce a graph. Memoized by
 * a content hash of the inputs.
 *
 * For repositories above {@link AnalyzeOptions.batchThreshold} files, analysis is
 * split into directory-grouped batches, each built and dropped in its own
 * ts-morph Project so memory stays bounded on huge trees. Cross-batch import edges
 * are recovered structurally so the import backbone is never broken; some
 * type-resolved call/inheritance edges that would span two batches may be absent
 * (an accepted tradeoff vs. OOMing on a repo that otherwise produces nothing).
 * At or below the threshold, output is identical to a single-project analysis.
 */
export function analyzeSources(files: SourceFileMap, options: AnalyzeOptions = {}): AnalyzeResult {
  const signature = analysisSignature(files, options);
  const cached = analysisCache.get(signature);
  if (cached) {
    analysisCache.delete(signature);
    analysisCache.set(signature, cached);
    return cached;
  }

  const result = computeAnalysis(files, options);

  analysisCache.set(signature, result);
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  return result;
}

function computeAnalysis(files: SourceFileMap, options: AnalyzeOptions): AnalyzeResult {
  const paths = Object.keys(files);
  const threshold = options.batchThreshold ?? DEFAULT_BATCH_THRESHOLD;

  // Fast path: small/normal repos analyze in a single project — byte-identical to
  // the pre-batching behavior.
  if (paths.length <= threshold) {
    const fragment = analyzeProject(files, options);
    return assembleResult([fragment], [], fragment.unresolved);
  }

  // Memory-bounded path: analyze directory batches, dropping each batch's project
  // (and its ASTs/checker) before building the next.
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = batchPathsByDirectory(paths, batchSize);

  const fragments: AnalysisFragment[] = [];
  const unresolved: UnresolvedRef[] = [];
  for (const batchPaths of batches) {
    const batchFiles: SourceFileMap = {};
    for (const path of batchPaths) batchFiles[path] = files[path];
    const fragment = analyzeProject(batchFiles, options);
    fragments.push({ ...fragment, unresolved: [] });
    unresolved.push(...fragment.unresolved);
  }

  // Recover import edges that span batch boundaries (each batch's checker only saw
  // its own files) by resolving specifiers structurally against the full set.
  const structural = structuralImportEdges(files);

  // A specifier flagged "unresolved" by a batch but resolvable against the full
  // file set is a cross-batch import, not a missing one — drop it.
  const realUnresolved = unresolved.filter((ref) => {
    const matched = structural.resolvedSpecs.get(ref.filePath);
    return !(matched?.has(ref.name) ?? false);
  });

  return assembleResult(fragments, structural.edges, realUnresolved);
}
