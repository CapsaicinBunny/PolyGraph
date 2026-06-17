// Minimal, dependency-free glob matcher for architecture-rule path patterns
// (e.g. `src/domain/**`, `**/*.test.ts`). Operates on forward-slash relative
// paths — the same normalized form GraphNode.filePath uses. Supports:
//   **  — any characters, including `/` (crosses directory boundaries)
//   *   — any characters except `/` (within a single path segment)
//   ?   — a single character except `/`
// Everything else is matched literally. There is no brace/`[...]` class support;
// the rule format only needs the three wildcards above.

const REGEX_SPECIALS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/** Compile a glob to an anchored RegExp matching whole forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // Globstar. When bounded by slashes (or string edges) it matches whole
        // segments including none — so `a/**/b` matches `a/b`, `a/x/b`, etc. We
        // consume an adjacent trailing slash so the optional group owns it.
        const atStart = i === 0;
        const prevSlash = atStart || g[i - 1] === "/";
        const nextSlash = g[i + 2] === "/";
        const atEnd = i + 2 === g.length;
        if (prevSlash && nextSlash) {
          re += "(?:.*/)?";
          i += 2; // skip the second '*' and the trailing '/'
        } else if (prevSlash && atEnd) {
          re += ".*";
          i += 1; // skip the second '*'
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (REGEX_SPECIALS.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `path` (any slash flavor) matches the glob. */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.replace(/\\/g, "/"));
}

/** True if `path` matches any of the globs. Empty list matches nothing. */
export function matchAnyGlob(globs: readonly string[], path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(p));
}
