// Recursive-descent parser: tokens -> AST. The grammar (v1):
//
//   query   := orExpr ( "->" orExpr )?        // at most one top-level path arrow
//   orExpr  := andExpr ( ("|" | "or") andExpr )*
//   andExpr := unary ( ["and"] unary )*       // juxtaposition = AND
//   unary   := ("-" | "not") unary | atom
//   atom    := "(" orExpr ")" | predicate | text
//
// Parsing never throws; a malformed query yields a `ParseError` node so the UI can show
// a message instead of crashing the render path.

import { type Token, tokenize } from "./tokenize";

export type CompareOp = ">" | "<" | ">=" | "<=" | "=";

export type Node =
  | { type: "and"; items: Node[] }
  | { type: "or"; items: Node[] }
  | { type: "not"; expr: Node }
  | { type: "predicate"; field: string; op: CompareOp; value: string }
  | { type: "text"; value: string }
  | { type: "path"; from: Node; to: Node }
  | { type: "error"; message: string };

export interface ParseResult {
  /** The root node, or null for an empty query. */
  ast: Node | null;
  error?: string;
}

const OP_PREFIXES: CompareOp[] = [">=", "<=", ">", "<", "="];

/** Split a `word` token into a predicate (field + op + value) or a free-text node. */
function classifyWord(value: string, quotedValue?: string): Node {
  const colon = value.indexOf(":");
  if (colon === -1) return { type: "text", value };
  const field = value.slice(0, colon).toLowerCase();
  let rest = value.slice(colon + 1);
  if (!field) return { type: "text", value };
  // A quoted value immediately follows an empty `field:` (e.g. `depends-on:"db"`).
  if (rest === "" && quotedValue !== undefined) rest = quotedValue;
  let op: CompareOp = "=";
  for (const p of OP_PREFIXES) {
    if (rest.startsWith(p)) {
      op = p;
      rest = rest.slice(p.length);
      break;
    }
  }
  return { type: "predicate", field, op, value: rest };
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): Node | null {
    if (this.tokens.length === 0) return null;
    const node = this.parsePath();
    if (this.pos < this.tokens.length) {
      return { type: "error", message: `Unexpected "${this.peek()?.value}"` };
    }
    return node;
  }

  private parsePath(): Node {
    const from = this.parseOr();
    if (this.peek()?.type === "arrow") {
      this.next();
      const to = this.parseOr();
      return { type: "path", from, to };
    }
    return from;
  }

  private parseOr(): Node {
    const items = [this.parseAnd()];
    for (;;) {
      const t = this.peek();
      const isOr = t?.type === "pipe" || (t?.type === "word" && t.value.toLowerCase() === "or");
      if (!isOr) break;
      this.next();
      items.push(this.parseAnd());
    }
    return items.length === 1 ? items[0] : { type: "or", items };
  }

  private parseAnd(): Node {
    const items = [this.parseUnary()];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      // AND continues while the next token starts another atom. Stop at structural
      // tokens that belong to an enclosing rule.
      if (t.type === "rparen" || t.type === "pipe" || t.type === "arrow") break;
      if (t.type === "word" && t.value.toLowerCase() === "or") break;
      if (t.type === "word" && t.value.toLowerCase() === "and") {
        this.next();
        items.push(this.parseUnary());
        continue;
      }
      items.push(this.parseUnary());
    }
    return items.length === 1 ? items[0] : { type: "and", items };
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t?.type === "not" || (t?.type === "word" && t.value.toLowerCase() === "not")) {
      this.next();
      return { type: "not", expr: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Node {
    const t = this.next();
    if (!t) return { type: "error", message: "Unexpected end of query" };
    if (t.type === "lparen") {
      const inner = this.parseOr();
      const close = this.next();
      if (close?.type !== "rparen") return { type: "error", message: "Missing )" };
      return inner;
    }
    if (t.type === "quoted") return { type: "text", value: t.value };
    if (t.type === "word") {
      // Pull in a trailing quoted token as the value for an empty `field:`.
      if (t.value.endsWith(":") && this.peek()?.type === "quoted") {
        return classifyWord(t.value, this.next()?.value);
      }
      return classifyWord(t.value);
    }
    return { type: "error", message: `Unexpected "${t.value}"` };
  }
}

/** Find the first error node anywhere in the tree (for surfacing a message). */
function firstError(node: Node | null): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "error":
      return node.message;
    case "not":
      return firstError(node.expr);
    case "path":
      return firstError(node.from) ?? firstError(node.to);
    case "and":
    case "or":
      for (const it of node.items) {
        const e = firstError(it);
        if (e) return e;
      }
      return undefined;
    default:
      return undefined;
  }
}

/** Parse a query string into an AST. */
export function parse(src: string): ParseResult {
  const ast = new Parser(tokenize(src)).parse();
  const error = firstError(ast);
  return error ? { ast, error } : { ast };
}
