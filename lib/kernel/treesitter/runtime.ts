// web-tree-sitter runtime: one-time WASM init + cached per-grammar Language
// loads. Pinned to web-tree-sitter 0.20.8 to match the ABI of the prebuilt
// tree-sitter-wasms grammars.
//
// The .wasm files are located by plain filesystem path (node_modules under the
// project root) and read at runtime by web-tree-sitter — deliberately NOT via
// require()/import. webpack would otherwise statically analyze a dynamic
// require.resolve and try to bundle every grammar wasm as a module (which fails,
// since wasm isn't an enabled webpack experiment). web-tree-sitter itself stays
// in serverExternalPackages so Next leaves its JS unbundled.

import { join } from "node:path";
import Parser from "web-tree-sitter";

const NODE_MODULES = join(process.cwd(), "node_modules");
const RUNTIME_WASM = join(NODE_MODULES, "web-tree-sitter", "tree-sitter.wasm");

function grammarWasmPath(grammar: string): string {
  return join(NODE_MODULES, "tree-sitter-wasms", "out", `tree-sitter-${grammar}.wasm`);
}

let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => RUNTIME_WASM });
  }
  return initPromise;
}

const langCache = new Map<string, Promise<Parser.Language>>();

/** Load (and cache) a grammar by its tree-sitter-wasms name, e.g. "python". */
export function loadLanguage(grammar: string): Promise<Parser.Language> {
  let p = langCache.get(grammar);
  if (!p) {
    p = ensureInit().then(() => Parser.Language.load(grammarWasmPath(grammar)));
    langCache.set(grammar, p);
  }
  return p;
}

export function createParser(language: Parser.Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export function createQuery(language: Parser.Language, source: string): Parser.Query {
  return language.query(source);
}
