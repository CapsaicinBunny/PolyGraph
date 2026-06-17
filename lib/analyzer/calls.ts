import { Node, type Project, SyntaxKind } from "ts-morph";
import type { GraphEdge } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
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

/**
 * Resolve a callee identifier to a target node id via "go to definition". Reports
 * whether the identifier resolved to more than one distinct project target
 * (ambiguous) so the edge's confidence can reflect it.
 */
function resolveTarget(
  ident: Node,
  index: DeclIndex,
): { target: string; ambiguous: boolean } | undefined {
  if (!Node.isIdentifier(ident)) return undefined;
  const ids = new Set<string>();
  for (const def of ident.getDefinitionNodes()) {
    const id = declarationNodeId(def, index.declToId);
    if (id) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  return { target: [...ids][0], ambiguous: ids.size > 1 };
}

/** Build type-resolved function/method call edges between symbol nodes. */
export function analyzeCalls(project: Project, index: DeclIndex): GraphEdge[] {
  const builder = new EdgeBuilder();

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

      const resolved = resolveTarget(ident, index);
      if (!resolved || resolved.target === source) continue;

      // `new X()` is an instantiation, not a plain call.
      const kind = Node.isNewExpression(callLike) ? "instantiates" : "call";
      builder.add(
        source,
        resolved.target,
        kind,
        nodeEvidence(callLike, resolved.ambiguous ? "ambiguous" : "exact"),
      );
    }
  }

  return builder.build();
}
