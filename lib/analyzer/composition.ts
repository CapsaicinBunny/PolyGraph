import { Node, type Project, SyntaxKind } from "ts-morph";
import { edgeId, type EdgeKind, type GraphEdge } from "../graph/types";
import { type DeclIndex, declarationNodeId } from "./nodes";

/**
 * Resolve every project class/interface referenced inside a type annotation.
 * Handles wrappers like `Engine[]`, `Array<Engine>`, `Map<string, Engine>` by
 * resolving each identifier in the type node and keeping the ones that map to a
 * known node.
 */
function resolveTypeTargets(typeNode: Node | undefined, index: DeclIndex): string[] {
  if (!typeNode) return [];
  const idents = Node.isIdentifier(typeNode)
    ? [typeNode]
    : typeNode.getDescendantsOfKind(SyntaxKind.Identifier);

  const out: string[] = [];
  for (const ident of idents) {
    for (const def of ident.getDefinitionNodes()) {
      const id = declarationNodeId(def, index.declToId);
      if (id) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** Build composition (`has`) and dependency-injection (`injects`) edges. */
export function analyzeComposition(project: Project, index: DeclIndex): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const push = (source: string, target: string, kind: EdgeKind) => {
    if (!target || source === target) return;
    const id = edgeId(source, target, kind);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, source, target, kind, occurrences: [], count: 0 });
  };

  for (const file of project.getSourceFiles()) {
    for (const cls of file.getClasses()) {
      const source = cls.getName() ? index.declToId.get(cls) : undefined;
      if (!source) continue;

      // Composition / has-a: typed fields.
      for (const prop of cls.getProperties()) {
        for (const target of resolveTypeTargets(prop.getTypeNode(), index))
          push(source, target, "has");
      }

      // Dependency injection: constructor parameter types.
      for (const ctor of cls.getConstructors()) {
        for (const param of ctor.getParameters()) {
          for (const target of resolveTypeTargets(param.getTypeNode(), index))
            push(source, target, "injects");
        }
      }
    }

    // Interfaces describe composition through their property types too.
    for (const iface of file.getInterfaces()) {
      const source = index.declToId.get(iface);
      if (!source) continue;
      for (const prop of iface.getProperties()) {
        for (const target of resolveTypeTargets(prop.getTypeNode(), index))
          push(source, target, "has");
      }
    }
  }

  return edges;
}
