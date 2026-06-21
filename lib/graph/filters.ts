// File-level filtering helpers: derive the top-level folders and languages present
// in a graph (for the Filters panel) and classify a file's folder/language.
import type { GraphModel } from "./types";
import { languageBadge } from "./visual";

/** Top-level directory of a relative path, or "/" for repo-root files. */
export function topFolderOf(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const slash = norm.indexOf("/");
  return slash === -1 ? "/" : norm.slice(0, slash);
}

export interface FileLanguage {
  /** Stable key (the language-badge code), e.g. "TS", "{}", or "other". */
  key: string;
  /** Human label, e.g. "TS", "JSON". */
  label: string;
  color: string;
}

// Friendlier labels for the cryptic badge codes; others display the code as-is.
const LANG_LABELS: Record<string, string> = {
  TX: "TSX",
  "C+": "C++",
  OC: "Obj-C",
  "{}": "JSON",
};

/** Language of a file from its extension badge; "other" if the extension is unknown. */
export function fileLanguage(filePath: string): FileLanguage {
  const badge = languageBadge(filePath);
  if (!badge) return { key: "other", label: "Other", color: "#6b7280" };
  return { key: badge.code, label: LANG_LABELS[badge.code] ?? badge.code, color: badge.color };
}

/**
 * Human language names → the badge code returned by `fileLanguage().key`. Shared by
 * every subsystem that accepts a `language` value from a user (the query language and
 * the rules selector) so `language:rust` and `facets: { language: ['rust'] }` resolve
 * identically. Codes (e.g. "RS") and unknown values pass through unchanged.
 */
const LANG_ALIASES: Record<string, string> = {
  rust: "RS",
  typescript: "TS",
  ts: "TS",
  tsx: "TX",
  javascript: "JS",
  js: "JS",
  python: "PY",
  py: "PY",
  go: "GO",
  golang: "GO",
  java: "JV",
  kotlin: "KT",
  scala: "SC",
  csharp: "C#",
  "c#": "C#",
  fsharp: "F#",
  "f#": "F#",
  cpp: "C+",
  "c++": "C+",
  c: "C",
  objc: "OC",
  "objective-c": "OC",
  swift: "SW",
  zig: "ZG",
  haskell: "HS",
  ruby: "RB",
  rb: "RB",
  php: "PH",
  bash: "SH",
  shell: "SH",
  sh: "SH",
  lua: "LU",
  dart: "DT",
  julia: "JL",
  jl: "JL",
  ocaml: "ML",
  ml: "ML",
  nix: "NX",
  r: "R",
  sql: "SQ",
  json: "{}",
  wasm: "WA",
  wat: "WA",
  vue: "VU",
  svelte: "SV",
};

/**
 * Canonicalize a user-supplied language value to the lowercased badge code used for
 * comparison. Maps a human name ("rust") to its badge code ("RS"), then lowercases;
 * a value already equal to a code ("RS") or unknown passes through (lowercased). Pair
 * with `fileLanguage(path).key.toLowerCase()` for a value-space-agnostic match.
 */
export function canonicalLanguageKey(value: string): string {
  const v = value.toLowerCase();
  return (LANG_ALIASES[v] ?? value).toLowerCase();
}

/** Languages that start hidden in the panel (re-enableable). JSON/JSONC. */
export const DEFAULT_HIDDEN_LANGUAGES: ReadonlySet<string> = new Set(["{}"]);

export interface FolderInfo {
  name: string;
  count: number;
}
export interface LanguageInfo extends FileLanguage {
  count: number;
}

/** Distinct top-level folders across file nodes, with counts, busiest first. */
export function availableFolders(graph: GraphModel): FolderInfo[] {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const f = topFolderOf(n.filePath);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Distinct languages across file nodes, with counts, busiest first. */
export function availableLanguages(graph: GraphModel): LanguageInfo[] {
  const byKey = new Map<string, LanguageInfo>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const lang = fileLanguage(n.filePath);
    const existing = byKey.get(lang.key);
    if (existing) existing.count += 1;
    else byKey.set(lang.key, { ...lang, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
