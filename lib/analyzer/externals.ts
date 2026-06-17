import { Node, type Project, SyntaxKind } from "ts-morph";
import {
  edgeId,
  type ExternalKind,
  fileNodeId,
  type GraphEdge,
  type GraphNode,
} from "../graph/types";
import type { PackageDeps } from "../server/package-deps";
import { NODE_BUILTINS } from "./facets";
import { type DeclIndex, enclosingNodeId } from "./nodes";
import { toRelativePath } from "./project";

export interface ExternalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Collapse a subpath import to its package name: `@scope/pkg/x` -> `@scope/pkg`, `pkg/x` -> `pkg`. */
export function npmPackageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
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
export function analyzeExternals(
  project: Project,
  index: DeclIndex,
  packages: PackageDeps = {},
): ExternalResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const addNode = (id: string, label: string, externalKind: ExternalKind) => {
    if (nodes.has(id)) return;
    const node: GraphNode = {
      id,
      kind: "external",
      label,
      filePath: "",
      line: 0,
      parentFile: id,
      externalKind,
    };
    if (externalKind === "npm") {
      const dep = packages[label];
      node.dependencyType = dep?.type ?? "undeclared";
      if (dep) node.version = dep.version;
    }
    nodes.set(id, node);
  };
  const addEdge = (source: string, target: string, kind: "import" | "call") => {
    const id = edgeId(source, target, kind);
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ id, source, target, kind, occurrences: [], count: 0 });
  };

  for (const file of project.getSourceFiles()) {
    const fileId = fileNodeId(toRelativePath(file.getFilePath()));

    // External module imports / re-exports.
    const moduleSpecs = [...file.getImportDeclarations(), ...file.getExportDeclarations()];
    for (const decl of moduleSpecs) {
      const spec = decl.getModuleSpecifierValue?.();
      if (!spec || !isBareSpecifier(spec)) continue;
      if (decl.getModuleSpecifierSourceFile()) continue; // resolves inside the project
      const externalKind = classifyModule(spec);
      // Collapse npm subpath imports to one node per package.
      const label = externalKind === "npm" ? npmPackageName(spec) : spec;
      const id = `external:module:${label}`;
      addNode(id, label, externalKind);
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
