// Loader for the native (napi-rs) analysis core. The compiled addon
// (analyzer-core/analyzer-core.node) is loaded by absolute path with
// process.dlopen — Node's raw native-addon loader. Using dlopen (rather than
// require/createRequire) bypasses webpack entirely, which otherwise shims the
// require and can't resolve the binary in the Next server bundle. If the addon
// isn't present (e.g. unbuilt on this platform), loadCore throws and the
// registry degrades to the TypeScript-only providers.

import { join } from "node:path";

export interface AnalyzerCore {
  /** Returns JSON `{ nodes, edges, errors }` for a bucket of same-language files. */
  analyze(grammar: string, querySrc: string, importStyle: string, filesJson: string): string;
}

let cached: AnalyzerCore | null = null;

export function loadCore(): AnalyzerCore {
  if (!cached) {
    const addonPath = join(process.cwd(), "analyzer-core", "analyzer-core.node");
    const mod = { exports: {} as AnalyzerCore };
    process.dlopen(mod, addonPath);
    cached = mod.exports;
  }
  return cached;
}
