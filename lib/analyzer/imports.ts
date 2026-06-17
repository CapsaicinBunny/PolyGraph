import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { fileNodeId, type GraphEdge } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
import { toRelativePath } from "./project";

function pushImport(
  builder: EdgeBuilder,
  fromFile: string,
  target: SourceFile | undefined,
  at: Node,
): void {
  if (!target) return; // module is outside the uploaded set
  const source = fileNodeId(fromFile);
  const dest = fileNodeId(toRelativePath(target.getFilePath()));
  if (source === dest) return;
  // Resolved to a project file via the type system → exact.
  builder.add(source, dest, "import", nodeEvidence(at, "exact"));
}

function collectFromFile(file: SourceFile, builder: EdgeBuilder): void {
  const fromFile = toRelativePath(file.getFilePath());

  for (const decl of file.getImportDeclarations()) {
    pushImport(builder, fromFile, decl.getModuleSpecifierSourceFile(), decl);
  }

  // Re-exports: `export { x } from "./y"` / `export * from "./y"`
  for (const decl of file.getExportDeclarations()) {
    pushImport(builder, fromFile, decl.getModuleSpecifierSourceFile(), decl);
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
    pushImport(builder, fromFile, resolved, call);
  }
}

/** Build module-level import edges between files. */
export function analyzeImports(project: Project): GraphEdge[] {
  const builder = new EdgeBuilder();
  for (const file of project.getSourceFiles()) {
    collectFromFile(file, builder);
  }
  return builder.build();
}
