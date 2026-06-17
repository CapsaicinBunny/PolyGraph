// A small, dependency-free TOML reader — just enough for the manifest fields we read
// (Cargo.toml, pyproject.toml): tables, array-of-tables, dotted keys, strings, numbers,
// booleans, arrays (incl. multi-line), and inline tables. Not a full TOML implementation;
// it ignores what it doesn't understand rather than throwing.

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

/** Strip a `#` comment that lies outside any string on the line. */
function stripComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split on top-level commas (ignoring commas inside strings/brackets/braces). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let cur = "";
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

/** Split a dotted key path, respecting quotes. */
function splitKey(key: string): string[] {
  return splitDottedOutsideQuotes(key).map(unquote);
}

function splitDottedOutsideQuotes(s: string): string[] {
  const out: string[] = [];
  let inStr: '"' | "'" | null = null;
  let cur = "";
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
    } else if (ch === ".") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((p) => p.trim());
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseValue(raw: string): TomlValue {
  const s = raw.trim();
  if (s === "") return "";
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[")) {
    const inner = s.slice(1, s.lastIndexOf("]"));
    return splitTopLevel(inner).map((p) => parseValue(p));
  }
  if (s.startsWith("{")) {
    const inner = s.slice(1, s.lastIndexOf("}"));
    const table: TomlTable = {};
    for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      assignPath(table, splitKey(pair.slice(0, eq)), parseValue(pair.slice(eq + 1)));
    }
    return table;
  }
  const num = Number(s);
  if (!Number.isNaN(num) && /^[-+0-9.eE_]+$/.test(s)) return Number(s.replace(/_/g, ""));
  return unquote(s);
}

function tableAt(root: TomlTable, path: string[], asArrayTable = false): TomlTable {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const last = i === path.length - 1;
    if (last && asArrayTable) {
      const arr = (cur[key] ??= []) as TomlValue[];
      const entry: TomlTable = {};
      (arr as TomlTable[]).push(entry);
      return entry;
    }
    const existing = cur[key];
    if (Array.isArray(existing)) {
      cur = existing[existing.length - 1] as TomlTable;
    } else if (existing && typeof existing === "object") {
      cur = existing as TomlTable;
    } else {
      const next: TomlTable = {};
      cur[key] = next;
      cur = next;
    }
  }
  return cur;
}

function assignPath(table: TomlTable, path: string[], value: TomlValue): void {
  const parent = path.length > 1 ? tableAt(table, path.slice(0, -1)) : table;
  parent[path[path.length - 1]] = value;
}

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current = root;

  const rawLines = src.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    let line = stripComment(rawLines[i]).trim();
    if (line === "") continue;

    if (line.startsWith("[")) {
      const arrayTable = line.startsWith("[[");
      const name = line.replace(/^\[+/, "").replace(/\]+$/, "").trim();
      current = tableAt(root, splitKey(name), arrayTable);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq);
    let valueText = line.slice(eq + 1).trim();
    // Continue multi-line arrays/inline tables until brackets balance.
    while (!bracketsBalanced(valueText) && i + 1 < rawLines.length) {
      i += 1;
      valueText += ` ${stripComment(rawLines[i]).trim()}`;
    }
    assignPath(current, splitKey(key), parseValue(valueText));
  }

  return root;
}

function bracketsBalanced(s: string): boolean {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (const ch of s) {
    if (inStr) {
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    }
  }
  return depth <= 0;
}
