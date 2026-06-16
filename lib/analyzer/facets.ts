import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Environment, Runtime } from "../graph/types";

// Common Node.js builtin module names (with or without the `node:` prefix).
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads",
  "zlib",
]);

// Global identifiers that imply a runtime when used as a value (not a property name).
const RUNTIME_GLOBALS: Record<string, Runtime> = {
  Bun: "bun",
  Deno: "deno",
  process: "node",
  Buffer: "node",
  __dirname: "node",
  __filename: "node",
  require: "node",
};

export interface FileFacets {
  environment?: Environment;
  runtimes: Runtime[];
  hasJsx: boolean;
}

/** Leading `"use client"` / `"use server"` directive, if present. */
function directiveEnvironment(file: SourceFile): Environment | undefined {
  for (const stmt of file.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) break; // directives must lead the file
    const expr = stmt.getExpression();
    if (!Node.isStringLiteral(expr)) break;
    const value = expr.getLiteralValue();
    if (value === "use client") return "client";
    if (value === "use server") return "server";
    // Some other directive prologue entry — keep scanning.
  }
  return undefined;
}

/**
 * True when the identifier is a value reference, not a *name* — excludes member
 * access names (`o.process`), object/type property keys (`{ process: number }`),
 * and declaration names, any of which could collide with a runtime global.
 */
function isValuePosition(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return true;
  const named = parent as { getNameNode?: () => Node };
  if (
    (Node.isPropertyAccessExpression(parent) ||
      Node.isPropertySignature(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isShorthandPropertyAssignment(parent) ||
      Node.isMethodSignature(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isPropertyDeclaration(parent) ||
      Node.isParameterDeclaration(parent)) &&
    named.getNameNode?.() === id
  ) {
    return false;
  }
  return true;
}

function runtimeFromModule(spec: string, runtimes: Set<Runtime>): void {
  if (spec === "bun" || spec.startsWith("bun:")) runtimes.add("bun");
  else if (spec.startsWith("node:") || NODE_BUILTINS.has(spec)) runtimes.add("node");
}

/** Detect environment, runtime(s), and JSX presence for a single source file. */
export function fileFacets(file: SourceFile): FileFacets {
  const runtimes = new Set<Runtime>();

  for (const imp of file.getImportDeclarations()) {
    runtimeFromModule(imp.getModuleSpecifierValue(), runtimes);
  }

  for (const id of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const runtime = RUNTIME_GLOBALS[id.getText()];
    if (runtime && isValuePosition(id)) runtimes.add(runtime);
  }

  const hasJsx =
    file.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    file.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    file.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined;

  return { environment: directiveEnvironment(file), runtimes: [...runtimes], hasJsx };
}
