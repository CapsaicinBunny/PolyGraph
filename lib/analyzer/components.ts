import { Node, type Project, SyntaxKind } from "ts-morph";
import type { GraphEdge } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
import { type DeclIndex, declarationNodeId, enclosingNodeId } from "./nodes";

/** Get the identifier that names a JSX tag: `<Foo/>` -> `Foo`; `<A.B/>` -> `B`. */
function tagIdentifier(tagNameNode: Node): Node | undefined {
  if (Node.isIdentifier(tagNameNode)) return tagNameNode;
  if (Node.isPropertyAccessExpression(tagNameNode)) return tagNameNode.getNameNode();
  return undefined;
}

/** A lowercase first letter means an intrinsic HTML element (div, span, ...). */
function isIntrinsic(ident: Node): boolean {
  const text = ident.getText();
  return text.length > 0 && text[0] === text[0].toLowerCase();
}

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

/** Build component render-usage edges from JSX elements to their components. */
export function analyzeComponents(project: Project, index: DeclIndex): GraphEdge[] {
  const builder = new EdgeBuilder();

  for (const file of project.getSourceFiles()) {
    const tagNodes: Node[] = [
      ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ];

    for (const tag of tagNodes) {
      if (!Node.isJsxOpeningElement(tag) && !Node.isJsxSelfClosingElement(tag)) continue;
      const ident = tagIdentifier(tag.getTagNameNode());
      if (!ident || isIntrinsic(ident)) continue;

      const source = enclosingNodeId(tag, index.declToId);
      if (!source) continue;

      const resolved = resolveTarget(ident, index);
      if (!resolved || resolved.target === source) continue;

      builder.add(
        source,
        resolved.target,
        "renders",
        nodeEvidence(tag, resolved.ambiguous ? "ambiguous" : "exact"),
      );
    }
  }

  return builder.build();
}
