// Shared graph model — used by both the server-side analyzer and the client UI.

export type NodeKind =
  | "file"
  | "class"
  | "interface"
  | "function"
  | "component"
  | "variable"
  | "external";

/** Source family of an external (out-of-project) node. */
export type ExternalKind = "node" | "deno" | "bun" | "npm";

/** How an imported npm package is declared in package.json (or not). */
export type DependencyType =
  | "dependency"
  | "devDependency"
  | "peerDependency"
  | "optionalDependency"
  | "undeclared";

export type EdgeKind =
  | "import"
  | "call"
  | "extends"
  | "implements"
  | "renders"
  | "instantiates"
  | "has"
  | "injects";

/**
 * A detected architectural role, orthogonal to the structural `kind`. Found by
 * scanning for paradigm signals (JSX, ECS naming/decorators/factories), so a
 * codebase's architecture surfaces without any configuration.
 */
export type NodeRole = "react-component" | "ecs-component" | "ecs-system" | "ecs-entity";

/** Where the code runs, from `"use client"` / `"use server"` directives. */
export type Environment = "client" | "server";

/** Detected JS runtime(s) a file targets, from its APIs and imports. */
export type Runtime = "node" | "deno" | "bun";

/** Coarse purpose: renders UI, or implements logic/data. */
export type NodeCategory = "ui" | "feature";

export interface GraphNode {
  /** Stable id: `${filePath}#${symbolName}` for symbols, or `${filePath}` for files. */
  id: string;
  kind: NodeKind;
  /** Display name. */
  label: string;
  /** Source file the node belongs to (relative path). */
  filePath: string;
  /** 1-based declaration line. 0 for file nodes. */
  line: number;
  /** Owning file node id, used for collapse/expand. Equals `id` for file nodes. */
  parentFile: string;
  /** Detected architectural role, if any (ECS / React). */
  role?: NodeRole;
  /** UI (renders something) vs feature (logic/data). */
  category?: NodeCategory;
  /** Client vs server, when a directive declares it. */
  environment?: Environment;
  /** JS runtimes the owning file targets (node / deno / bun). */
  runtimes?: Runtime[];
  /** For `kind: "external"`, which source family it belongs to. */
  externalKind?: ExternalKind;
  /** For npm externals: declared version from package.json, if known. */
  version?: string;
  /** For npm externals: how the package is declared (or "undeclared"). */
  dependencyType?: DependencyType;
}

export interface GraphEdge {
  /** Stable id: `${source}->${target}:${kind}`. */
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AnalyzeError {
  filePath: string;
  message: string;
}

export interface AnalyzeResult {
  graph: GraphModel;
  errors: AnalyzeError[];
}

/** A map of relative file path to its source text — the upload payload. */
export type SourceFileMap = Record<string, string>;

export const FILE_NODE_LINE = 0;

/** Build the canonical id for a file node. */
export function fileNodeId(filePath: string): string {
  return filePath;
}

/** Build the canonical id for a symbol node. */
export function symbolNodeId(filePath: string, symbolName: string): string {
  return `${filePath}#${symbolName}`;
}

/** Build the canonical id for an edge. */
export function edgeId(source: string, target: string, kind: EdgeKind): string {
  return `${source}->${target}:${kind}`;
}
