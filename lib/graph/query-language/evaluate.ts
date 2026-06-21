// Compile + evaluate a parsed query against a graph. Evaluation is set-based: every AST
// node yields a Set of matching node ids, so boolean ops are plain set algebra and
// `depends-on` is a single multi-source reverse BFS rather than a per-node walk.

import type { DimensionIndex } from "../dimension-index";
import { canonicalFacetKey } from "../facet-aliases";
import { canonicalLanguageKey, fileLanguage } from "../filters";
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
  /**
   * The runtime dimension index over the same graph. When present, `<key>:<value>`
   * for any registered dimension (built-in facets keyed by their catalog key, plus
   * provider facets like `rust.visibility`) resolves from the index. Absent, the
   * built-in facet fields fall back to the legacy typed node fields.
   */
  dimensions?: DimensionIndex;
}

// Query field aliases (environment→env, lang→language) come from the shared
// ../facet-aliases module, so the query language, rule selectors, and config validation
// all resolve the documented aliases identically (review bug d).

/**
 * Built-in query fields handled by their own (richer) logic — numeric/structural —
 * and never delegated to the dimension index even when also a catalog dimension.
 * `kind`/`language` are structural dimensions but keep their bespoke handling
 * (kind is a direct compare; language applies human-name aliases + `fileLanguage`).
 */
const BUILTIN_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "language",
  "lang",
  "path",
  "package",
  "pkg",
  "dependency-type",
  "dep",
  "calls",
  "incoming",
  "outgoing",
  "cycle",
  "depends-on",
  "depends_on",
]);

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
  return fileLanguage(node.filePath).key.toLowerCase() === canonicalLanguageKey(value);
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

/**
 * Resolve a `<key>:<value>` predicate against the dimension index for a node by
 * ordinal. Returns `true`/`false` when the (alias-resolved) key is a registered
 * dimension, or `undefined` when it is not — so the caller can fall back to the
 * legacy field read or a lenient text match.
 */
function matchFacetViaIndex(
  index: DimensionIndex,
  ordinal: number,
  field: string,
  value: string,
): boolean | undefined {
  const key = canonicalFacetKey(field);
  if (!index.descriptor(key)) return undefined; // not a registered dimension
  const v = value.toLowerCase();
  for (const id of index.valuesOfOrdinal(ordinal, key)) {
    if (index.valueString(key, id).toLowerCase() === v) return true;
  }
  return false;
}

/** Per-node predicate (everything except `depends-on`, which is set-level). */
function matchesPredicate(
  node: GraphNode,
  ordinal: number,
  field: string,
  op: CompareOp,
  value: string,
  metrics: MetricsIndex,
  opts: EvalOptions,
): boolean {
  const v = value.toLowerCase();
  // Built-in numeric/structural fields keep their bespoke handling. Every other
  // field is a dimension lookup: prefer the registry (so provider facets like
  // rust.visibility work and legacy aliases map to catalog keys), then fall back
  // to the legacy typed fields, then a lenient text match. The legacy-field cases
  // below (env/runtime/category/role) are a DEFERRED-removal fallback: they cover a
  // graph queried without an index AND legacy-only nodes whose `facets` is unset,
  // and retire with the GraphNode legacy fields in Phase E (see graph/types.ts).
  if (!BUILTIN_FIELDS.has(field) && opts.dimensions) {
    const hit = matchFacetViaIndex(opts.dimensions, ordinal, field, value);
    if (hit !== undefined) return hit;
  }
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
      // `category` defaults to "feature" (the ubiquitous value is never stored on
      // the legacy field), so absence resolves to it — matching the index path.
      return (node.category ?? "feature").toLowerCase() === v;
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
      // Indexed loop: the ordinal is the dimension index's node key, so a facet
      // predicate can read the interned columnar values for this node.
      for (let ordinal = 0; ordinal < graph.nodes.length; ordinal++) {
        const n = graph.nodes[ordinal];
        if (matchesPredicate(n, ordinal, node.field, node.op, node.value, metrics, opts)) {
          out.add(n.id);
        }
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
