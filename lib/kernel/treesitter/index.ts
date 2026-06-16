// Build a LanguageProvider from a declarative pack. The grammar + query are
// loaded once (async) at construction; afterwards analyze() is synchronous —
// tree-sitter parsing itself is sync and fast. Each file is parsed, queried, and
// freed; the per-file extracts are then resolved into the universal graph IR.

import type { AnalyzeError } from "../../graph/types";
import type { LanguageProvider, ProviderResult } from "../provider";
import { extractFile, type FileExtract } from "./extract";
import { loadPack } from "./pack";
import { buildGraphFromExtracts } from "./resolve";
import { createParser, createQuery, loadLanguage } from "./runtime";

export async function createTreeSitterProvider(packId: string): Promise<LanguageProvider> {
  const pack = await loadPack(packId);
  const language = await loadLanguage(pack.grammar);
  const parser = createParser(language);
  const query = createQuery(language, pack.query);

  return {
    id: pack.id,
    extensions: pack.extensions,
    analyze(files: Record<string, string>): ProviderResult {
      const errors: AnalyzeError[] = [];
      const perFile = new Map<string, FileExtract>();
      for (const [path, text] of Object.entries(files)) {
        const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
        let tree = null;
        try {
          tree = parser.parse(text);
          if (!tree) {
            errors.push({ filePath: norm, message: "Parse failed" });
            continue;
          }
          perFile.set(norm, extractFile(norm, tree, query));
        } catch (e) {
          errors.push({ filePath: norm, message: e instanceof Error ? e.message : "Parse error" });
        } finally {
          tree?.delete();
        }
      }
      const graph = buildGraphFromExtracts(perFile, pack.importStyle);
      return { nodes: graph.nodes, edges: graph.edges, errors };
    },
  };
}
