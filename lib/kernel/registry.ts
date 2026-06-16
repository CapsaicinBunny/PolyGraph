// The set of language providers, built once. TypeScript/JS is the precise
// compiler-backed provider; declarative tree-sitter packs are added by id. If a
// pack fails to load (e.g. a grammar wasm can't be resolved), the kernel
// degrades gracefully to whatever providers did load rather than failing the
// whole analysis.

import { tsProvider } from "../analyzer/provider";
import type { LanguageProvider } from "./provider";
import { createTreeSitterProvider } from "./treesitter";

/** Declarative packs to load, by language-packs/<id> folder name. */
const TREE_SITTER_PACKS = [
  "python",
  "java",
  "kotlin",
  "rust",
  "go",
  "scala",
  "csharp",
  "fsharp",
  "c",
  "cpp",
  "objc",
  "swift",
  "zig",
  "haskell",
  "jsonc",
  "wasm",
];

let cached: Promise<LanguageProvider[]> | null = null;

async function build(): Promise<LanguageProvider[]> {
  const providers: LanguageProvider[] = [tsProvider];
  for (const id of TREE_SITTER_PACKS) {
    try {
      providers.push(await createTreeSitterProvider(id));
    } catch (e) {
      console.error(`[kernel] failed to load "${id}" language pack:`, e);
    }
  }
  return providers;
}

export function getProviders(): Promise<LanguageProvider[]> {
  if (!cached) cached = build();
  return cached;
}
