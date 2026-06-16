// Run a pack's tree-sitter query over one parsed file and produce raw, fully
// string-resolved fragments (no live AST nodes escape, so the Tree can be freed
// right after). Capture-name convention (the kernel's universal contract):
//   @definition.<kind>   a symbol declaration, paired with @name
//   @reference.<rel>     a reference (call / extends / implements), paired with @name
//   @import + @module    an import statement and its module path; optional @import.name
// Symbols fold like the TS analyzer: classes always become nodes; functions only
// when top-level. Methods/nested functions attribute their references to the
// nearest enclosing emitted symbol (their class or top-level function).

import type Parser from "web-tree-sitter";
import { fileNodeId, symbolNodeId } from "../../graph/types";

type Node = Parser.SyntaxNode;

export interface RawSymbol {
  id: string;
  name: string;
  kind: string;
  line: number;
}

export interface RawRef {
  relation: string;
  name: string;
  /** Enclosing emitted symbol id, or the file node id for top-level references. */
  sourceId: string;
}

export interface RawImport {
  module: string;
  /** The bound local name, when the statement imports a specific symbol. */
  name?: string;
}

export interface FileExtract {
  symbols: RawSymbol[];
  refs: RawRef[];
  imports: RawImport[];
}

const CLASS_LIKE = new Set(["class", "interface", "struct", "enum"]);

interface DefRec {
  node: Node;
  name: string;
  kind: string;
  line: number;
}

export function extractFile(filePath: string, tree: Parser.Tree, query: Parser.Query): FileExtract {
  const defs: DefRec[] = [];
  const refMatches: { relation: string; name: string; node: Node }[] = [];
  const imports: RawImport[] = [];

  for (const match of query.matches(tree.rootNode)) {
    let nameNode: Node | undefined;
    let defKind: string | undefined;
    let defNode: Node | undefined;
    let refRel: string | undefined;
    let refNode: Node | undefined;
    let moduleNode: Node | undefined;
    let importName: string | undefined;
    let isImport = false;

    for (const c of match.captures) {
      if (c.name === "name") nameNode = c.node;
      else if (c.name === "module") moduleNode = c.node;
      else if (c.name === "import.name") importName = c.node.text;
      else if (c.name === "import") isImport = true;
      else if (c.name.startsWith("definition.")) {
        defKind = c.name.slice("definition.".length);
        defNode = c.node;
      } else if (c.name.startsWith("reference.")) {
        refRel = c.name.slice("reference.".length);
        refNode = c.node;
      }
    }

    if (isImport && moduleNode) {
      imports.push({ module: moduleNode.text, name: importName });
    } else if (defKind && defNode && nameNode) {
      defs.push({
        node: defNode,
        name: nameNode.text,
        kind: defKind,
        line: defNode.startPosition.row + 1,
      });
    } else if (refRel && refNode && nameNode) {
      refMatches.push({ relation: refRel, name: nameNode.text, node: refNode });
    }
  }

  const defByNodeId = new Map<number, DefRec>();
  for (const d of defs) defByNodeId.set(d.node.id, d);

  const nearestDefAbove = (node: Node): DefRec | undefined => {
    let cur = node.parent;
    while (cur) {
      const d = defByNodeId.get(cur.id);
      if (d) return d;
      cur = cur.parent;
    }
    return undefined;
  };

  // A class is always a node; a function is a node only when top-level. Others
  // fold into the nearest emitted ancestor for reference attribution.
  const emittedOwnId = new Map<number, string>();
  const symbols: RawSymbol[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    const emit = CLASS_LIKE.has(d.kind) || nearestDefAbove(d.node) === undefined;
    if (!emit) continue;
    const id = symbolNodeId(filePath, d.name);
    emittedOwnId.set(d.node.id, id);
    if (!seen.has(id)) {
      seen.add(id);
      symbols.push({ id, name: d.name, kind: d.kind, line: d.line });
    }
  }

  // The emitted symbol a reference belongs to: nearest enclosing (or self) def
  // that became a node. Methods resolve to their class; nested funcs to theirs.
  const enclosingEmittedId = (node: Node): string | undefined => {
    let cur: Node | null = node;
    while (cur) {
      const own = emittedOwnId.get(cur.id);
      if (own) return own;
      cur = cur.parent;
    }
    return undefined;
  };

  const fileId = fileNodeId(filePath);
  const refs: RawRef[] = refMatches.map((rm) => ({
    relation: rm.relation,
    name: rm.name,
    sourceId: enclosingEmittedId(rm.node) ?? fileId,
  }));

  return { symbols, refs, imports };
}
