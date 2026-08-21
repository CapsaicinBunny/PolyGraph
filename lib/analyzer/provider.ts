// The TypeScript/JavaScript provider — a precise, compiler-backed plugin. It
// wraps the existing ts-morph analyzer (analyzeSources), keeping its
// type-resolved calls, JSX component/renders detection, and externals
// enrichment. This is the "high-fidelity" end of the plugin spectrum.

import type { LanguageProvider, ProviderContext, ProviderResult } from "../kernel/provider";
import { TS_FACET_DESCRIPTORS } from "./facet-schema";
import { analyzeSources } from "./index";

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
];

export const tsProvider: LanguageProvider = {
  id: "typescript",
  extensions: EXTENSIONS,
  analyze(files: Record<string, string>, ctx: ProviderContext): ProviderResult {
    const { graph, errors, unresolved } = analyzeSources(files, { packages: ctx.packages });
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      errors,
      unresolved,
      facetSchema: TS_FACET_DESCRIPTORS,
    };
  },
};
