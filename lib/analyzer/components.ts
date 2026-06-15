import { Node, type Project, SyntaxKind } from "ts-morph";
import { edgeId, type GraphEdge } from "../graph/types";
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

function resolveTarget(ident: Node, index: DeclIndex): string | undefined {
  if (!Node.isIdentifier(ident)) return undefined;
  for (const def of ident.getDefinitionNodes()) {
    const id = declarationNodeId(def, index.declToId);
    if (id) return id;
  }
  return undefined;
}

/** Build component render-usage edges from JSX elements to their components. */
export function analyzeComponents(project: Project, index: DeclIndex): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

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

      const target = resolveTarget(ident, index);
      if (!target || target === source) continue;

      const id = edgeId(source, target, "renders");
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target, kind: "renders" });
    }
  }

  return edges;
}
