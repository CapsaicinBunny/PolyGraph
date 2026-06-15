import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { edgeId, fileNodeId, type GraphEdge } from "../graph/types";
import { toRelativePath } from "./project";

function pushImport(
  edges: GraphEdge[],
  seen: Set<string>,
  fromFile: string,
  target: SourceFile | undefined,
): void {
  if (!target) return; // module is outside the uploaded set
  const source = fileNodeId(fromFile);
  const dest = fileNodeId(toRelativePath(target.getFilePath()));
  if (source === dest) return;
  const id = edgeId(source, dest, "import");
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, source, target: dest, kind: "import" });
}

function collectFromFile(file: SourceFile, edges: GraphEdge[], seen: Set<string>): void {
  const fromFile = toRelativePath(file.getFilePath());

  for (const decl of file.getImportDeclarations()) {
    pushImport(edges, seen, fromFile, decl.getModuleSpecifierSourceFile());
  }

  // Re-exports: `export { x } from "./y"` / `export * from "./y"`
  for (const decl of file.getExportDeclarations()) {
    pushImport(edges, seen, fromFile, decl.getModuleSpecifierSourceFile());
  }

  // Dynamic import() and require()
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const isDynamicImport = expr.getKind() === SyntaxKind.ImportKeyword;
    const isRequire = Node.isIdentifier(expr) && expr.getText() === "require";
    if (!isDynamicImport && !isRequire) continue;

    const arg = call.getArguments()[0];
    if (!arg || !Node.isStringLiteral(arg)) continue;
    const resolved = file.getReferencedSourceFiles().find((sf) => {
      const rel = toRelativePath(sf.getFilePath());
      return rel.includes(arg.getLiteralValue().replace(/^\.\//, ""));
    });
    pushImport(edges, seen, fromFile, resolved);
  }
}

/** Build module-level import edges between files. */
export function analyzeImports(project: Project): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const file of project.getSourceFiles()) {
    collectFromFile(file, edges, seen);
  }
  return edges;
}
