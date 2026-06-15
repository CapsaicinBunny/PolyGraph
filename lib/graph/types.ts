// Shared graph model — used by both the server-side analyzer and the client UI.

export type NodeKind = "file" | "class" | "interface" | "function" | "component";

export type EdgeKind = "import" | "call" | "extends" | "implements" | "renders";

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
