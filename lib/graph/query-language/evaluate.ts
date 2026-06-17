// Compile + evaluate a parsed query against a graph. Evaluation is set-based: every AST
// node yields a Set of matching node ids, so boolean ops are plain set algebra and
// `depends-on` is a single multi-source reverse BFS rather than a per-node walk.

import { fileLanguage } from "../filters";
import type { GraphModel, GraphNode } from "../types";
import { buildMetrics, type MetricsIndex } from "./metrics";
import { type CompareOp, type Node, parse } from "./parse";

export interface QueryResult {
  /** Nodes the query selects. */
  nodeIds: Set<string>;
  /** Edges to emphasise: induced edges for node queries, or matching edges for paths. */
  edgeIds: Set<string>;
  /** Parse/eval error message, if any. When set, nodeIds/edgeIds are empty. */
  error?: string;
  /** True when the query is empty (no constraints). */
  empty: boolean;
}

export interface EvalOptions {
  /** Resolve a node's package name, when the package level is active. */
  packageOf?: (node: GraphNode) => string | undefined;
}

// Human language names → the badge code returned by fileLanguage().key.
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

const DEP_TYPE_ALIASES: Record<string, string> = {
  prod: "dependency",
  dev: "devDependency",
  peer: "peerDependency",
  optional: "optionalDependency",
};

/** Case-insensitive glob match supporting `**` (any), `*` (within a segment), `?`. */
function globMatch(path: string, glob: string): boolean {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  let re = "";
  const g = glob.replace(/\\/g, "/").toLowerCase();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(norm);
}

function matchesText(node: GraphNode, text: string): boolean {
  const t = text.toLowerCase();
  return node.label.toLowerCase().includes(t) || node.filePath.toLowerCase().includes(t);
}

function languageMatches(node: GraphNode, value: string): boolean {
  const v = value.toLowerCase();
  const want = (LANG_ALIASES[v] ?? value).toLowerCase();
  return fileLanguage(node.filePath).key.toLowerCase() === want;
}

function compareNum(actual: number, op: CompareOp, raw: string): boolean {
  const n = Number(raw);
  if (Number.isNaN(n)) return false;
  switch (op) {
    case ">":
      return actual > n;
    case "<":
      return actual < n;
    case ">=":
      return actual >= n;
    case "<=":
      return actual <= n;
    case "=":
      return actual === n;
  }
}

function isTruthy(value: string): boolean {
  const v = value.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Per-node predicate (everything except `depends-on`, which is set-level). */
function matchesPredicate(
  node: GraphNode,
  field: string,
  op: CompareOp,
  value: string,
  metrics: MetricsIndex,
  opts: EvalOptions,
): boolean {
  const v = value.toLowerCase();
  switch (field) {
    case "kind":
      return node.kind.toLowerCase() === v;
    case "language":
    case "lang":
      return languageMatches(node, value);
    case "path":
      return globMatch(node.filePath, value);
    case "environment":
    case "env":
      return node.environment?.toLowerCase() === v;
    case "runtime":
      return (node.runtimes ?? []).some((r) => r.toLowerCase() === v);
    case "category":
      return node.category?.toLowerCase() === v;
    case "role":
      return node.role?.toLowerCase() === v;
    case "package":
    case "pkg": {
      const pkg = opts.packageOf?.(node) ?? node.label;
      return pkg.toLowerCase().includes(v);
    }
    case "dependency-type":
    case "dep": {
      const want = DEP_TYPE_ALIASES[v] ?? value;
      return node.dependencyType?.toLowerCase() === want.toLowerCase();
    }
    case "calls":
      return compareNum(metrics.callsOut(node.id), op, value);
    case "incoming":
      return compareNum(metrics.inDegree(node.id), op, value);
    case "outgoing":
      return compareNum(metrics.outDegree(node.id), op, value);
    case "cycle":
      return metrics.inCycle(node.id) === isTruthy(value);
    default:
      // Unknown field: fall back to a lenient text match on the value.
      return matchesText(node, value);
  }
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const id of small) if (big.has(id)) out.add(id);
  return out;
}

/** Evaluate an AST node to the set of node ids it selects. */
function evalSet(
  node: Node,
  graph: GraphModel,
  metrics: MetricsIndex,
  opts: EvalOptions,
): Set<string> {
  switch (node.type) {
    case "text": {
      const out = new Set<string>();
      for (const n of graph.nodes) if (matchesText(n, node.value)) out.add(n.id);
      return out;
    }
    case "predicate": {
      if (node.field === "depends-on" || node.field === "depends_on") {
        const targets = new Set<string>();
        for (const n of graph.nodes) if (matchesText(n, node.value)) targets.add(n.id);
        return metrics.reverseReachable(targets);
      }
      const out = new Set<string>();
      for (const n of graph.nodes) {
        if (matchesPredicate(n, node.field, node.op, node.value, metrics, opts)) out.add(n.id);
      }
      return out;
    }
    case "and": {
      let acc: Set<string> | null = null;
      for (const it of node.items) {
        const s = evalSet(it, graph, metrics, opts);
        acc = acc === null ? s : intersect(acc, s);
        if (acc.size === 0) break;
      }
      return acc ?? new Set();
    }
    case "or": {
      const out = new Set<string>();
      for (const it of node.items) for (const id of evalSet(it, graph, metrics, opts)) out.add(id);
      return out;
    }
    case "not": {
      const inner = evalSet(node.expr, graph, metrics, opts);
      const out = new Set<string>();
      for (const id of metrics.allIds) if (!inner.has(id)) out.add(id);
      return out;
    }
    case "path": {
      // A nested path contributes its endpoints as a node set.
      const r = evalPath(node, graph, metrics, opts);
      return r.nodeIds;
    }
    case "error":
      return new Set();
  }
}

/** Evaluate a top-level path node into matching edges + their endpoints. */
function evalPath(
  node: Extract<Node, { type: "path" }>,
  graph: GraphModel,
  metrics: MetricsIndex,
  opts: EvalOptions,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const from = evalSet(node.from, graph, metrics, opts);
  const to = evalSet(node.to, graph, metrics, opts);
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (from.has(e.source) && to.has(e.target)) {
      edgeIds.add(e.id);
      nodeIds.add(e.source);
      nodeIds.add(e.target);
    }
  }
  return { nodeIds, edgeIds };
}

const EMPTY: QueryResult = { nodeIds: new Set(), edgeIds: new Set(), empty: true };

/** Parse and evaluate a query string against a graph. Never throws. */
export function runQuery(graph: GraphModel, query: string, opts: EvalOptions = {}): QueryResult {
  const { ast, error } = parse(query);
  if (error) return { nodeIds: new Set(), edgeIds: new Set(), error, empty: false };
  if (!ast) return EMPTY;

  const metrics = buildMetrics(graph);

  if (ast.type === "path") {
    const { nodeIds, edgeIds } = evalPath(ast, graph, metrics, opts);
    return { nodeIds, edgeIds, empty: false };
  }

  const nodeIds = evalSet(ast, graph, metrics, opts);
  // Induced edges: both endpoints selected.
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) edgeIds.add(e.id);
  }
  return { nodeIds, edgeIds, empty: false };
}
