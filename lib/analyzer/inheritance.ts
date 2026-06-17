import { Node, type Project } from "ts-morph";
import { edgeId, type EdgeKind, type GraphEdge } from "../graph/types";
import { type DeclIndex, declarationNodeId } from "./nodes";

/** Resolve a heritage expression (the thing after extends/implements) to a node id. */
function resolveHeritage(expr: Node, index: DeclIndex): string | undefined {
  let identifier: Node = Node.isExpressionWithTypeArguments(expr) ? expr.getExpression() : expr;
  if (Node.isPropertyAccessExpression(identifier)) identifier = identifier.getNameNode();
  if (!Node.isIdentifier(identifier)) return undefined;

  // "Go to definition" follows imports across files, unlike the raw symbol.
  for (const def of identifier.getDefinitionNodes()) {
    const id = declarationNodeId(def, index.declToId);
    if (id) return id;
  }
  return undefined;
}

function pushEdge(
  edges: GraphEdge[],
  seen: Set<string>,
  source: string,
  target: string | undefined,
  kind: EdgeKind,
): void {
  if (!target || source === target) return;
  const id = edgeId(source, target, kind);
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, source, target, kind, occurrences: [], count: 0 });
}

/** Build extends/implements edges between classes and interfaces. */
export function analyzeInheritance(project: Project, index: DeclIndex): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const file of project.getSourceFiles()) {
    for (const cls of file.getClasses()) {
      const source = cls.getName() ? index.declToId.get(cls) : undefined;
      if (!source) continue;

      const ext = cls.getExtends();
      if (ext) pushEdge(edges, seen, source, resolveHeritage(ext, index), "extends");

      for (const impl of cls.getImplements()) {
        pushEdge(edges, seen, source, resolveHeritage(impl, index), "implements");
      }
    }

    for (const iface of file.getInterfaces()) {
      const source = index.declToId.get(iface);
      if (!source) continue;
      for (const ext of iface.getExtends()) {
        pushEdge(edges, seen, source, resolveHeritage(ext, index), "extends");
      }
    }
  }

  return edges;
}
