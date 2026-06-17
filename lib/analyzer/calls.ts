import { Node, type Project, SyntaxKind } from "ts-morph";
import { edgeId, type GraphEdge } from "../graph/types";
import { type DeclIndex, declarationNodeId, enclosingNodeId } from "./nodes";

/**
 * Get the identifier node that names the callee, so we can resolve its definition.
 * `foo()` -> `foo`; `obj.method()` -> `method`; `new Foo()` -> `Foo`.
 */
function calleeIdentifier(callLike: Node): Node | undefined {
  const expr =
    Node.isCallExpression(callLike) || Node.isNewExpression(callLike)
      ? callLike.getExpression()
      : undefined;
  if (!expr) return undefined;
  if (Node.isPropertyAccessExpression(expr)) return expr.getNameNode();
  if (Node.isIdentifier(expr)) return expr;
  return undefined;
}

/** Resolve a callee identifier to a target node id via "go to definition". */
function resolveTarget(ident: Node, index: DeclIndex): string | undefined {
  if (!Node.isIdentifier(ident)) return undefined;
  for (const def of ident.getDefinitionNodes()) {
    const id = declarationNodeId(def, index.declToId);
    if (id) return id;
  }
  return undefined;
}

/** Build type-resolved function/method call edges between symbol nodes. */
export function analyzeCalls(project: Project, index: DeclIndex): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const file of project.getSourceFiles()) {
    const callLikes: Node[] = [
      ...file.getDescendantsOfKind(SyntaxKind.CallExpression),
      ...file.getDescendantsOfKind(SyntaxKind.NewExpression),
    ];

    for (const callLike of callLikes) {
      const source = enclosingNodeId(callLike, index.declToId);
      if (!source) continue;

      const ident = calleeIdentifier(callLike);
      if (!ident) continue;

      const target = resolveTarget(ident, index);
      if (!target || target === source) continue;

      // `new X()` is an instantiation, not a plain call.
      const kind = Node.isNewExpression(callLike) ? "instantiates" : "call";
      const id = edgeId(source, target, kind);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target, kind, occurrences: [], count: 0 });
    }
  }

  return edges;
}
