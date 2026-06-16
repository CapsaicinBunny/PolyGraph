import { Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import {
  fileNodeId,
  FILE_NODE_LINE,
  type GraphNode,
  type NodeKind,
  type NodeRole,
  symbolNodeId,
} from "../graph/types";
import { toRelativePath } from "./project";
import { classOrInterfaceRole, functionRole, variableRole } from "./roles";

export interface DeclIndex {
  nodes: GraphNode[];
  /** Maps a declaration AST node to the GraphNode id it produced. */
  declToId: Map<Node, string>;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** A function/arrow is a component if it is PascalCase and renders JSX. */
function returnsJsx(node: Node): boolean {
  return (
    node.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  );
}

function classifyFunction(name: string, body: Node): NodeKind {
  return isPascalCase(name) && returnsJsx(body) ? "component" : "function";
}

function collectFromFile(file: SourceFile, index: DeclIndex): void {
  const filePath = toRelativePath(file.getFilePath());
  const parentFile = fileNodeId(filePath);

  index.nodes.push({
    id: parentFile,
    kind: "file",
    label: filePath.split("/").pop() ?? filePath,
    filePath,
    line: FILE_NODE_LINE,
    parentFile,
  });

  const add = (decl: Node, name: string, kind: NodeKind, role?: NodeRole) => {
    const id = symbolNodeId(filePath, name);
    index.nodes.push({
      id,
      kind,
      label: name,
      filePath,
      line: decl.getStartLineNumber(),
      parentFile,
      ...(role ? { role } : {}),
    });
    index.declToId.set(decl, id);
  };

  for (const cls of file.getClasses()) {
    const name = cls.getName();
    if (name) add(cls, name, "class", classOrInterfaceRole(cls, name));
  }

  for (const iface of file.getInterfaces()) {
    const name = iface.getName();
    add(iface, name, "interface", classOrInterfaceRole(iface, name));
  }

  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const kind = classifyFunction(name, fn);
    // A JSX-returning PascalCase function is a React component; otherwise tag any ECS role.
    add(fn, name, kind, kind === "component" ? "react-component" : functionRole(name));
  }

  for (const varDecl of file.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (!init) continue;
    const name = varDecl.getName();

    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      const kind = classifyFunction(name, init);
      add(varDecl, name, kind, kind === "component" ? "react-component" : functionRole(name));
      continue;
    }

    // Data-oriented ECS: `const Position = defineComponent({...})`, etc.
    const role = variableRole(init, name);
    if (role) add(varDecl, name, "variable", role);
  }
}

/** Build the node set and declaration index for every source file in the project. */
export function buildDeclIndex(project: Project): DeclIndex {
  const index: DeclIndex = { nodes: [], declToId: new Map() };
  for (const file of project.getSourceFiles()) {
    collectFromFile(file, index);
  }
  return index;
}

/**
 * Find the GraphNode id of the nearest enclosing symbol for an arbitrary node.
 * Methods/constructors fold into their owning class. Returns undefined for
 * top-level code that belongs to no symbol node.
 */
export function enclosingNodeId(node: Node, declToId: Map<Node, string>): string | undefined {
  let current: Node | undefined = node;
  while (current) {
    const direct = declToId.get(current);
    if (direct) return direct;

    if (
      Node.isMethodDeclaration(current) ||
      Node.isConstructorDeclaration(current) ||
      Node.isGetAccessorDeclaration(current) ||
      Node.isSetAccessorDeclaration(current)
    ) {
      const cls = current.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      if (cls) {
        const id = declToId.get(cls);
        if (id) return id;
      }
    }

    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const parent = current.getParent();
      if (parent && Node.isVariableDeclaration(parent)) {
        const id = declToId.get(parent);
        if (id) return id;
      }
    }

    current = current.getParent();
  }
  return undefined;
}

/**
 * Map a resolved declaration (a call/inheritance target) to a GraphNode id.
 * Methods resolve to their class; arrow/function expressions to their variable.
 */
export function declarationNodeId(decl: Node, declToId: Map<Node, string>): string | undefined {
  const direct = declToId.get(decl);
  if (direct) return direct;

  if (
    Node.isMethodDeclaration(decl) ||
    Node.isConstructorDeclaration(decl) ||
    Node.isGetAccessorDeclaration(decl) ||
    Node.isSetAccessorDeclaration(decl)
  ) {
    const cls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (cls) return declToId.get(cls);
  }

  if (Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    const parent = decl.getParent();
    if (parent && Node.isVariableDeclaration(parent)) return declToId.get(parent);
  }

  return undefined;
}
