import { Node, type Project, SyntaxKind } from "ts-morph";
import {
  edgeId,
  type ExternalKind,
  fileNodeId,
  type GraphEdge,
  type GraphNode,
} from "../graph/types";
import { NODE_BUILTINS } from "./facets";
import { type DeclIndex, enclosingNodeId } from "./nodes";
import { toRelativePath } from "./project";

export interface ExternalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Runtime globals whose member usage becomes an external API node.
const RUNTIME_GLOBALS: Record<string, ExternalKind> = {
  Bun: "bun",
  Deno: "deno",
  process: "node",
};

function classifyModule(spec: string): ExternalKind {
  if (spec === "bun" || spec.startsWith("bun:")) return "bun";
  if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) return "node";
  if (spec.startsWith("https://") || spec.startsWith("jsr:") || spec.startsWith("deno:")) {
    return "deno";
  }
  return "npm";
}

function isBareSpecifier(spec: string): boolean {
  return spec.length > 0 && !spec.startsWith(".") && !spec.startsWith("/");
}

/**
 * Capture out-of-project symbols as external nodes:
 * - imported packages / builtins (an `import` edge from the importing file)
 * - `Bun.*` / `Deno.*` / `process.*` API usage (a `call` edge from the caller)
 *
 * These are always computed; the UI decides whether to show them.
 */
export function analyzeExternals(project: Project, index: DeclIndex): ExternalResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const addNode = (id: string, label: string, externalKind: ExternalKind) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "external",
        label,
        filePath: "",
        line: 0,
        parentFile: id,
        externalKind,
      });
    }
  };
  const addEdge = (source: string, target: string, kind: "import" | "call") => {
    const id = edgeId(source, target, kind);
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ id, source, target, kind });
  };

  for (const file of project.getSourceFiles()) {
    const fileId = fileNodeId(toRelativePath(file.getFilePath()));

    // External module imports / re-exports.
    const moduleSpecs = [...file.getImportDeclarations(), ...file.getExportDeclarations()];
    for (const decl of moduleSpecs) {
      const spec = decl.getModuleSpecifierValue?.();
      if (!spec || !isBareSpecifier(spec)) continue;
      if (decl.getModuleSpecifierSourceFile()) continue; // resolves inside the project
      const id = `external:module:${spec}`;
      addNode(id, spec, classifyModule(spec));
      addEdge(fileId, id, "import");
    }

    // Runtime global API usage: Bun.serve, Deno.readFile, process.cwd, ...
    for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const obj = access.getExpression();
      if (!Node.isIdentifier(obj)) continue;
      const externalKind = RUNTIME_GLOBALS[obj.getText()];
      if (!externalKind) continue;

      const label = `${obj.getText()}.${access.getName()}`;
      const id = `external:api:${label}`;
      addNode(id, label, externalKind);
      const source = enclosingNodeId(access, index.declToId) ?? fileId;
      addEdge(source, id, "call");
    }
  }

  return { nodes: [...nodes.values()], edges };
}
