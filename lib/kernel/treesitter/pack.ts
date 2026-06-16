// A language pack is the declarative definition of a language: a tiny YAML of
// metadata plus a tree-sitter query (tags.scm) using the standard capture
// convention the extractor understands. Adding a language = drop a folder under
// language-packs/<id>/ with pack.yaml + tags.scm; no kernel code changes.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LanguagePack {
  id: string;
  /** Extensions WITH the leading dot, e.g. [".py"]. */
  extensions: string[];
  /** tree-sitter-wasms grammar name, e.g. "python". */
  grammar: string;
  /** Module-resolution style for import edges, e.g. "python". */
  importStyle: string;
  /** The tree-sitter query source (tags.scm). */
  query: string;
}

interface PackMeta {
  id: string;
  extensions: string[];
  grammar: string;
  imports?: { style?: string };
  queries?: string;
}

// POLYGRAPH_PACKS lets a packaged build (the Bun sidecar binary / Tauri app)
// point at the bundled language-packs resource dir; otherwise resolve relative
// to the working directory for local dev and tests. `||` (not `??`) so an empty
// value falls through to the default rather than yielding a broken path.
export function packsDir(): string {
  return process.env.POLYGRAPH_PACKS || join(process.cwd(), "language-packs");
}

export async function loadPack(id: string): Promise<LanguagePack> {
  const dir = join(packsDir(), id);
  const meta = parseYaml(await readFile(join(dir, "pack.yaml"), "utf8")) as PackMeta;
  const query = await readFile(join(dir, meta.queries ?? "tags.scm"), "utf8");
  return {
    id: meta.id,
    extensions: meta.extensions,
    grammar: meta.grammar,
    importStyle: meta.imports?.style ?? meta.id,
    query,
  };
}
