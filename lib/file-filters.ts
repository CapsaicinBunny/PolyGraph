// Shared file-selection rules, used by both the in-browser reader and the
// server-side directory scanner so they include/exclude exactly the same files.

export const SOURCE_EXT =
  /\.(tsx?|jsx?|mts|cts|mjs|cjs|vue|svelte|py|java|kts?|rs|go|scala|sc|cs|fsx?|c|h|cpp|cc|cxx|hpp|hh|hxx|mm?|ml|swift|zig|hs|rb|php|sh|bash|lua|dart|jl|r|nix|sql|jsonc?|wat)$/i;

// Matches an ignored directory segment anywhere in a path (either separator).
export const IGNORE_DIR =
  /(^|[\\/])(node_modules|\.git|\.next|dist|build|out|coverage|\.turbo|\.cache|target|\.venv|venv|__pycache__|vendor|bin|obj|\.gradle|Pods|\.dart_tool|\.svelte-kit|\.nuxt|\.idea|\.vscode)([\\/]|$)/;

export const MAX_FILE_BYTES = 1_000_000; // skip very large files (likely generated/minified)

/** True if a path looks like a source file we should read (by extension + ignore rules). */
export function isSourcePath(path: string): boolean {
  return SOURCE_EXT.test(path) && !IGNORE_DIR.test(path);
}
