// Shared graph model — used by both the server-side analyzer and the client UI.

// Universal, language-neutral node taxonomy. Each language parser emits the
// subset that fits its constructs (a Rust parser uses struct/trait/macro, a
// Java parser uses class/interface/method/field/annotation, etc.).
export type NodeKind =
  | "file"
  // type / container declarations
  | "class"
  | "interface"
  | "struct"
  | "trait"
  | "protocol"
  | "enum"
  | "union"
  | "record"
  | "object"
  | "type"
  | "namespace"
  | "module"
  // callables
  | "function"
  | "method"
  | "constructor"
  | "accessor"
  | "component"
  | "macro"
  // values / members
  | "variable"
  | "constant"
  | "field"
  | "property"
  | "annotation"
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
export type NodeRole =
  | "react-component"
  | "vue-component"
  | "svelte-component"
  | "angular-component"
  | "angular-service"
  | "angular-module"
  | "angular-directive"
  | "angular-pipe"
  | "ecs-component"
  | "ecs-system"
  | "ecs-entity";

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

export type EdgeConfidence = "exact" | "inferred" | "ambiguous";

/** One concrete occurrence of an edge: where the relationship was observed. */
export interface EdgeEvidence {
  /** Relative path of the occurrence. */
  filePath: string;
  /** 1-based line. */
  line: number;
  /** 1-based column; omitted when a provider can't supply it. */
  column?: number;
  /** Resolving provider, e.g. "TypeScript" or a language name for native packs. */
  provider: string;
  confidence: EdgeConfidence;
}

/** Max occurrences retained per edge; `count` may exceed this. */
export const OCCURRENCE_CAP = 25;

export interface GraphEdge {
  /** Stable id: `${source}->${target}:${kind}`. */
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Captured occurrences, capped at OCCURRENCE_CAP. */
  occurrences: EdgeEvidence[];
  /** Exact total occurrences (may exceed occurrences.length). */
  count: number;
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

/** Build a GraphEdge, deriving its id and count from the given occurrences. */
export function makeEdge(
  source: string,
  target: string,
  kind: EdgeKind,
  occurrences: EdgeEvidence[] = [],
): GraphEdge {
  return {
    id: edgeId(source, target, kind),
    source,
    target,
    kind,
    occurrences,
    count: occurrences.length,
  };
}

/** Append `from`'s occurrences into `into` up to OCCURRENCE_CAP; sum counts. */
export function mergeEvidence(
  into: { occurrences: EdgeEvidence[]; count: number },
  from: { occurrences: EdgeEvidence[]; count: number },
): void {
  for (const ev of from.occurrences) {
    if (into.occurrences.length < OCCURRENCE_CAP) into.occurrences.push(ev);
  }
  into.count += from.count;
}
