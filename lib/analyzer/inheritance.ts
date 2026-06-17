import { Node, type Project } from "ts-morph";
import type { EdgeKind, GraphEdge } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
import { type DeclIndex, declarationNodeId } from "./nodes";

/** Resolve a heritage expression (after extends/implements) to a node id + ambiguity. */
function resolveHeritage(
  expr: Node,
  index: DeclIndex,
): { target: string; ambiguous: boolean } | undefined {
  let identifier: Node = Node.isExpressionWithTypeArguments(expr) ? expr.getExpression() : expr;
  if (Node.isPropertyAccessExpression(identifier)) identifier = identifier.getNameNode();
  if (!Node.isIdentifier(identifier)) return undefined;

  // "Go to definition" follows imports across files, unlike the raw symbol.
  const ids = new Set<string>();
  for (const def of identifier.getDefinitionNodes()) {
    const id = declarationNodeId(def, index.declToId);
    if (id) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  return { target: [...ids][0], ambiguous: ids.size > 1 };
}

function pushEdge(
  builder: EdgeBuilder,
  source: string,
  resolved: { target: string; ambiguous: boolean } | undefined,
  kind: EdgeKind,
  at: Node,
): void {
  if (!resolved || source === resolved.target) return;
  builder.add(
    source,
    resolved.target,
    kind,
    nodeEvidence(at, resolved.ambiguous ? "ambiguous" : "exact"),
  );
}

/** Build extends/implements edges between classes and interfaces. */
export function analyzeInheritance(project: Project, index: DeclIndex): GraphEdge[] {
  const builder = new EdgeBuilder();

  for (const file of project.getSourceFiles()) {
    for (const cls of file.getClasses()) {
      const source = cls.getName() ? index.declToId.get(cls) : undefined;
      if (!source) continue;

      const ext = cls.getExtends();
      if (ext) pushEdge(builder, source, resolveHeritage(ext, index), "extends", ext);

      for (const impl of cls.getImplements()) {
        pushEdge(builder, source, resolveHeritage(impl, index), "implements", impl);
      }
    }

    for (const iface of file.getInterfaces()) {
      const source = index.declToId.get(iface);
      if (!source) continue;
      for (const ext of iface.getExtends()) {
        pushEdge(builder, source, resolveHeritage(ext, index), "extends", ext);
      }
    }
  }

  return builder.build();
}
