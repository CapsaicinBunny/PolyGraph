// Cross-file resolution for tree-sitter packs: turn per-file raw extracts into
// graph nodes + edges. References resolve by name with import awareness — a name
// is matched first against the file's own symbols, then against names brought in
// by imports (mapped to their source file's symbol). Heuristic, but plenty for a
// dependency graph; a language can later swap in a precise provider if needed.

import {
  edgeId,
  type EdgeKind,
  fileNodeId,
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  type NodeKind,
} from "../../graph/types";
import type { FileExtract } from "./extract";

const KIND_MAP: Record<string, NodeKind> = {
  class: "class",
  interface: "interface",
  struct: "type",
  enum: "enum",
  type: "type",
  function: "function",
  method: "function",
  variable: "variable",
};

const REF_KINDS = new Set<EdgeKind>(["call", "extends", "implements"]);

function dirSegments(path: string): string[] {
  const i = path.lastIndexOf("/");
  return (i >= 0 ? path.slice(0, i) : "").split("/").filter(Boolean);
}

/**
 * Python-style dotted/relative module resolution against the scanned file set.
 * `a.b` -> a/b.py or a/b/__init__.py; leading dots are relative to the importer.
 */
function resolvePythonModule(
  module: string,
  fromFile: string,
  fileSet: Set<string>,
): string | undefined {
  let segments: string[];
  if (module.startsWith(".")) {
    let dots = 0;
    while (dots < module.length && module[dots] === ".") dots++;
    const rest = module.slice(dots).split(".").filter(Boolean);
    let base = dirSegments(fromFile);
    for (let k = 1; k < dots; k++) base = base.slice(0, -1);
    segments = [...base, ...rest];
  } else {
    segments = module.split(".").filter(Boolean);
  }
  if (segments.length === 0) return undefined;
  const path = segments.join("/");
  for (const candidate of [`${path}.py`, `${path}/__init__.py`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveModule(
  style: string,
  module: string,
  fromFile: string,
  fileSet: Set<string>,
): string | undefined {
  if (style === "python") return resolvePythonModule(module, fromFile, fileSet);
  return undefined;
}

export function buildGraphFromExtracts(
  perFile: Map<string, FileExtract>,
  importStyle: string,
): GraphModel {
  const files = [...perFile.keys()];
  const fileSet = new Set(files);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const symbolsByFile = new Map<string, Map<string, string>>();

  for (const file of files) {
    const fileId = fileNodeId(file);
    nodes.push({
      id: fileId,
      kind: "file",
      label: file.split("/").pop() ?? file,
      filePath: file,
      line: 0,
      parentFile: fileId,
      category: "feature",
    });
    const nameToId = new Map<string, string>();
    for (const s of perFile.get(file)!.symbols) {
      nodes.push({
        id: s.id,
        kind: KIND_MAP[s.kind] ?? "function",
        label: s.name,
        filePath: file,
        line: s.line,
        parentFile: fileId,
        category: "feature",
      });
      if (!nameToId.has(s.name)) nameToId.set(s.name, s.id);
    }
    symbolsByFile.set(file, nameToId);
  }

  // Import edges (file -> file) + the local-name -> source-file bindings used to
  // resolve calls/inheritance across files.
  const importedNames = new Map<string, Map<string, string>>();
  for (const file of files) {
    const fileId = fileNodeId(file);
    const binds = new Map<string, string>();
    for (const imp of perFile.get(file)!.imports) {
      const target = resolveModule(importStyle, imp.module, file, fileSet);
      if (!target) continue;
      const targetId = fileNodeId(target);
      edges.push({
        id: edgeId(fileId, targetId, "import"),
        source: fileId,
        target: targetId,
        kind: "import",
      });
      if (imp.name) binds.set(imp.name, target);
    }
    importedNames.set(file, binds);
  }

  for (const file of files) {
    const local = symbolsByFile.get(file)!;
    const binds = importedNames.get(file)!;
    for (const r of perFile.get(file)!.refs) {
      const kind = r.relation as EdgeKind;
      if (!REF_KINDS.has(kind)) continue;
      let target: string | undefined;
      if (local.has(r.name)) {
        target = local.get(r.name);
      } else if (binds.has(r.name)) {
        const sourceFile = binds.get(r.name)!;
        target = symbolsByFile.get(sourceFile)?.get(r.name) ?? fileNodeId(sourceFile);
      }
      if (!target || target === r.sourceId) continue;
      edges.push({ id: edgeId(r.sourceId, target, kind), source: r.sourceId, target, kind });
    }
  }

  return { nodes, edges };
}
