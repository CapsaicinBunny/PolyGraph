// Loader for the native (napi-rs) analysis core. The compiled addon
// (analyzer-core/analyzer-core.node) is loaded by absolute path with
// process.dlopen — Node's raw native-addon loader. Using dlopen (rather than
// require/createRequire) bypasses webpack entirely, which otherwise shims the
// require and can't resolve the binary in the Next server bundle. If the addon
// isn't present (e.g. unbuilt on this platform), loadCore throws and the
// registry degrades to the TypeScript-only providers.

import { join } from "node:path";

export interface AnalyzerCore {
  /**
   * Returns a Promise resolving to JSON `{ nodes, edges, errors }` for a bucket
   * of same-language files. The native binding runs the parse on napi's libuv
   * threadpool (off the JS thread), so callers must await the result.
   */
  analyze(
    grammar: string,
    querySrc: string,
    importStyle: string,
    filesJson: string,
  ): Promise<string>;
}

/**
 * Absolute path to the native addon. POLYGRAPH_CORE lets a packaged build (the
 * Bun sidecar / Tauri app) point at a bundled .node outside the repo; otherwise
 * it resolves relative to the working directory for local dev and tests.
 */
export function resolveCorePath(): string {
  // `||` (not `??`): an empty POLYGRAPH_CORE is treated as unset rather than a
  // bad addon path that would make dlopen throw cryptically.
  return process.env.POLYGRAPH_CORE || join(process.cwd(), "analyzer-core", "analyzer-core.node");
}

let cached: AnalyzerCore | null = null;

export function loadCore(): AnalyzerCore {
  if (!cached) {
    const mod = { exports: {} as AnalyzerCore };
    process.dlopen(mod, resolveCorePath());
    cached = mod.exports;
  }
  return cached;
}
