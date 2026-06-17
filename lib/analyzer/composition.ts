import { Node, type Project, SyntaxKind } from "ts-morph";
import type { EdgeKind, GraphEdge } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
import { type DeclIndex, declarationNodeId } from "./nodes";

interface TypeTarget {
  target: string;
  ambiguous: boolean;
  at: Node;
}

/**
 * Resolve every project class/interface referenced inside a type annotation.
 * Handles wrappers like `Engine[]`, `Array<Engine>`, `Map<string, Engine>` by
 * resolving each identifier in the type node and keeping the ones that map to a
 * known node. Each identifier carries its location + whether it resolved
 * ambiguously (>1 distinct definition).
 */
function resolveTypeTargets(typeNode: Node | undefined, index: DeclIndex): TypeTarget[] {
  if (!typeNode) return [];
  const idents = Node.isIdentifier(typeNode)
    ? [typeNode]
    : typeNode.getDescendantsOfKind(SyntaxKind.Identifier);

  const out: TypeTarget[] = [];
  for (const ident of idents) {
    const ids = new Set<string>();
    for (const def of ident.getDefinitionNodes()) {
      const id = declarationNodeId(def, index.declToId);
      if (id) ids.add(id);
    }
    if (ids.size > 0) out.push({ target: [...ids][0], ambiguous: ids.size > 1, at: ident });
  }
  return out;
}

/** Build composition (`has`) and dependency-injection (`injects`) edges. */
export function analyzeComposition(project: Project, index: DeclIndex): GraphEdge[] {
  const builder = new EdgeBuilder();

  const push = (source: string, t: TypeTarget, kind: EdgeKind) => {
    if (source === t.target) return;
    builder.add(source, t.target, kind, nodeEvidence(t.at, t.ambiguous ? "ambiguous" : "exact"));
  };

  for (const file of project.getSourceFiles()) {
    for (const cls of file.getClasses()) {
      const source = cls.getName() ? index.declToId.get(cls) : undefined;
      if (!source) continue;

      // Composition / has-a: typed fields.
      for (const prop of cls.getProperties()) {
        for (const t of resolveTypeTargets(prop.getTypeNode(), index)) push(source, t, "has");
      }

      // Dependency injection: constructor parameter types.
      for (const ctor of cls.getConstructors()) {
        for (const param of ctor.getParameters()) {
          for (const t of resolveTypeTargets(param.getTypeNode(), index))
            push(source, t, "injects");
        }
      }
    }

    // Interfaces describe composition through their property types too.
    for (const iface of file.getInterfaces()) {
      const source = index.declToId.get(iface);
      if (!source) continue;
      for (const prop of iface.getProperties()) {
        for (const t of resolveTypeTargets(prop.getTypeNode(), index)) push(source, t, "has");
      }
    }
  }

  return builder.build();
}
