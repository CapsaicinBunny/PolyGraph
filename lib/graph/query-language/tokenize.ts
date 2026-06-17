// Lexer for the search query language. Produces a flat token stream that the parser
// turns into an AST. Designed so the tricky characters — `-` (negation vs. mid-word
// hyphen like `depends-on`), `->` (path arrow), and `"…"` quoted values — tokenize
// unambiguously.

export type TokenType = "word" | "quoted" | "arrow" | "lparen" | "rparen" | "pipe" | "not";

export interface Token {
  type: TokenType;
  /** For `word`/`quoted`: the text value (quotes stripped). */
  value: string;
}

const STRUCTURAL = new Set(["(", ")", "|", '"']);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** True when the two-char run at `i` begins a `->` path arrow. */
function isArrowAt(src: string, i: number): boolean {
  return src[i] === "-" && src[i + 1] === ">";
}

/**
 * Tokenize a query string. Never throws — unterminated quotes simply run to end of input.
 * Whitespace is insignificant except as a token separator.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (isArrowAt(src, i)) {
      tokens.push({ type: "arrow", value: "->" });
      i += 2;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === "|") {
      tokens.push({ type: "pipe", value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Quoted string — runs to the closing quote or end of input.
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== '"') {
        value += src[j];
        j += 1;
      }
      tokens.push({ type: "quoted", value });
      i = j < src.length ? j + 1 : j; // skip closing quote if present
      continue;
    }
    // A standalone leading `-` (not part of `->`) is negation; a hyphen inside a word
    // (e.g. `depends-on`) is consumed by the word reader below, so it never reaches here.
    if (ch === "-") {
      tokens.push({ type: "not", value: "-" });
      i += 1;
      continue;
    }
    // Word: run until whitespace, a structural char, or a `->` arrow.
    let j = i;
    let value = "";
    while (j < src.length && !isSpace(src[j]) && !STRUCTURAL.has(src[j]) && !isArrowAt(src, j)) {
      value += src[j];
      j += 1;
    }
    tokens.push({ type: "word", value });
    i = j;
  }
  return tokens;
}
