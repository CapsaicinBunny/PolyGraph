import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { fileNodeId, type GraphEdge, type UnresolvedRef } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";
import { nodeEvidence } from "./evidence";
import { toRelativePath } from "./project";

/**
 * A specifier that should resolve to a project file: relative (`./`, `../`, `/`)
 * or a known path alias (`@/`, `~/`). Bare specifiers like `react` are externals
 * (handled elsewhere), not unresolved references.
 */
function isProjectSpecifier(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec.startsWith("@/") ||
    spec.startsWith("~/")
  );
}

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

/** Record a project-style specifier that resolved to no file in the scanned set. */
function pushUnresolved(out: UnresolvedRef[], fromFile: string, spec: string, at: Node): void {
  if (!isProjectSpecifier(spec)) return; // bare specifier → external, not unresolved
  const sf = at.getSourceFile();
  const { line, column } = sf.getLineAndColumnAtPos(at.getStart());
  out.push({ sourceId: fileNodeId(fromFile), name: spec, filePath: fromFile, line, column });
}

function collectFromFile(
  file: SourceFile,
  builder: EdgeBuilder,
  unresolved: UnresolvedRef[],
): void {
  const fromFile = toRelativePath(file.getFilePath());

  for (const decl of file.getImportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile();
    if (target) pushImport(builder, fromFile, target, decl);
    else pushUnresolved(unresolved, fromFile, decl.getModuleSpecifierValue(), decl);
  }

  // Re-exports: `export { x } from "./y"` / `export * from "./y"`
  for (const decl of file.getExportDeclarations()) {
    const target = decl.getModuleSpecifierSourceFile();
    if (target) pushImport(builder, fromFile, target, decl);
    else {
      // `export { x }` with no `from` has no specifier — skip those.
      const spec = decl.getModuleSpecifierValue();
      if (spec) pushUnresolved(unresolved, fromFile, spec, decl);
    }
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

export interface ImportAnalysis {
  edges: GraphEdge[];
  unresolved: UnresolvedRef[];
}

/** Build module-level import edges between files, plus broken project imports. */
export function analyzeImports(project: Project): ImportAnalysis {
  const builder = new EdgeBuilder();
  const unresolved: UnresolvedRef[] = [];
  for (const file of project.getSourceFiles()) {
    collectFromFile(file, builder, unresolved);
  }
  return { edges: builder.build(), unresolved };
}
