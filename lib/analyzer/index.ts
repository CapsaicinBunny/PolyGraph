import type {
  AnalyzeError,
  AnalyzeResult,
  GraphEdge,
  GraphModel,
  GraphNode,
  SourceFileMap,
} from "../graph/types";
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
    if (!byId.has(edge.id)) byId.set(edge.id, edge);
  }
  // Drop edges whose endpoints are not known nodes is handled by callers using
  // the node set; here we only de-duplicate.
  return [...byId.values()];
}

export interface AnalyzeOptions {
  /** Declared dependencies (from package.json) used to enrich npm external nodes. */
  packages?: PackageDeps;
}

/**
 * Analyze a map of source files into a graph model. Files that fail to parse are
 * collected into `errors` and skipped; the rest still produce a graph.
 */
export function analyzeSources(files: SourceFileMap, options: AnalyzeOptions = {}): AnalyzeResult {
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

  const edges: GraphEdge[] = [
    ...analyzeImports(project),
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
  return { graph, errors };
}
