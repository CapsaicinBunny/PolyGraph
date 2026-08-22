// The ten PolyGraph operations the MCP tools expose, returning structured data.
// Deliberately free of any MCP/SDK types so they're unit-testable directly against
// a fixture; mcp/server.ts wraps each one as a tool.

import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type ScanResult, scanRevision, scanTarget, WORKING_TREE } from "../lib/cli/scan";
import { loadConfigFile } from "../lib/config/load";
import { diffGraphs } from "../lib/diff/diff";
import { analyzeInsights, unresolvedToInsights } from "../lib/graph/insights";
import { blastRadius, whyConnected } from "../lib/graph/query";
import { KNOWN_QUERY_FIELDS, parse, type QueryNode, runQuery } from "../lib/graph/query-language";
import type { GraphNode } from "../lib/graph/types";
import { evaluate } from "../lib/rules/engine";
import { toSarifString } from "../lib/rules/sarif";
import type { HistogramSummary } from "../lib/telemetry";
import { getScan, rootKey } from "./cache";
import { type BriefNode, briefNode, edgeConfidence, errMsg, histogram } from "./format";
import { telemetry } from "./telemetry";

// List results are capped so a single tool call can't flood an agent's context
// window. Every capped list is paired with the true total in the same result (a
// `*Total` field or an existing count), because the consumer is an LLM: given only
// a truncated list it will summarize the cap as if it were the whole answer.
const LIST_CAP = 100;
const EDGE_CAP = 50;
const NODE_CAP = 30;
const CYCLE_CAP = 10;
const NODE_ID_CAP = 10;

/** One actionable message for every "that id isn't in the graph" case. */
function unknownNodeMessage(id: string): string {
  return `No node with id "${id}". Discover ids with polygraph_query — e.g. {"query":"path:**/<file>"} or {"query":"kind:file"} — then use a returned node's id.`;
}

/**
 * Field names used in `query` that the evaluator doesn't recognize. Unknown fields
 * are NOT an error there — they degrade to a lenient text match on the value — so
 * without this a typo'd field is indistinguishable from a valid query that matched
 * nothing, and an agent concludes the codebase has no such thing.
 */
function unknownQueryFields(query: string): string[] {
  const found = new Set<string>();
  const walk = (n: QueryNode | null): void => {
    if (!n) return;
    switch (n.type) {
      case "and":
      case "or":
        for (const item of n.items) walk(item);
        return;
      case "not":
        walk(n.expr);
        return;
      case "path":
        walk(n.from);
        walk(n.to);
        return;
      case "predicate":
        if (!KNOWN_QUERY_FIELDS.has(n.field)) found.add(n.field);
        return;
      default:
        return;
    }
  };
  walk(parse(query).ast);
  return [...found].sort();
}

// Result types below are `type` aliases, not interfaces: the MCP SDK's
// `structuredContent` requires assignability to `{ [k: string]: unknown }`, which
// object-literal type aliases get implicitly but interfaces do not. (BriefNode in
// format.ts stays an interface — it's only ever nested, never assigned directly.)

// --- scan -------------------------------------------------------------------

export type ScanSummary = {
  root: string;
  scannedAt: number;
  fileCount: number;
  skipped: number;
  nodeCount: number;
  edgeCount: number;
  parseWarnings: number;
  /**
   * The files behind `parseWarnings` (capped at LIST_CAP). Without these the count
   * is unactionable — and worse, the follow-up tools present a graph missing those
   * files' symbols as if it were complete ("nothing depends on this, safe to
   * delete", when the only caller lives in a file that failed to parse).
   */
  parseErrors: { filePath: string; message: string }[];
  unresolved: number;
  nodeKinds: Record<string, number>;
  edgeKinds: Record<string, number>;
  edgeConfidence: Record<string, number>;
  packagesTotal: number;
  packages: { id: string; ecosystem: string }[];
  scanMs: number;
  analyzeMs: number;
};

export async function scanSummary(path: string): Promise<ScanSummary> {
  // Always rescan: polygraph_scan is how a caller asks for the CURRENT state after
  // editing files, so serving it from cache would report a stale graph.
  const d = await getScan(path, { refresh: true });
  return {
    root: d.root,
    scannedAt: d.scannedAt,
    fileCount: d.fileCount,
    skipped: d.skipped,
    nodeCount: d.graph.nodes.length,
    edgeCount: d.graph.edges.length,
    parseWarnings: d.errors.length,
    parseErrors: d.errors
      .slice(0, LIST_CAP)
      .map((e) => ({ filePath: e.filePath, message: e.message })),
    unresolved: d.unresolved.length,
    nodeKinds: histogram(d.graph.nodes.map((n) => n.kind)),
    edgeKinds: histogram(d.graph.edges.map((e) => e.kind)),
    edgeConfidence: histogram(d.graph.edges.map(edgeConfidence)),
    packagesTotal: d.manifests.length,
    packages: d.manifests.slice(0, LIST_CAP).map((m) => ({ id: m.id, ecosystem: m.ecosystem })),
    scanMs: Math.round(d.timings.scanMs),
    analyzeMs: Math.round(d.timings.analyzeMs),
  };
}

// --- query ------------------------------------------------------------------

export type QueryNodes = {
  query: string;
  scannedAt: number;
  /** Total matches — the number this page is drawn from. Page with `hasMore`. */
  matchCount: number;
  returned: number;
  /** Where this page started, and whether more results follow it. */
  offset: number;
  hasMore: boolean;
  empty: boolean;
  /** Set when the query could not be parsed; `nodes` is then empty. */
  error?: string;
  /**
   * Fields the evaluator didn't recognize. Present means the result is probably not
   * the answer to the question asked: unknown fields degrade to a text match, so
   * `matchCount: 0` here means "no such field", not "no such code".
   */
  unknownFields?: string[];
  nodes: BriefNode[];
};

export async function queryNodes(
  path: string,
  query: string,
  limit = 50,
  offset = 0,
): Promise<QueryNodes> {
  const d = await getScan(path);
  const r = runQuery(d.graph, query);
  if (r.error) {
    return {
      query,
      scannedAt: d.scannedAt,
      matchCount: 0,
      returned: 0,
      offset,
      hasMore: false,
      empty: r.empty,
      error: `${r.error} — in query "${query}". Syntax: field matches (kind:, path:, language:), AND/OR/NOT, degree metrics (incoming > 10), flow (a -> b).`,
      nodes: [],
    };
  }
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  // Sorted by id so paging is stable ACROSS RESCANS: polygraph_scan force-refreshes
  // and the LRU can evict, so a later page may be served from a rebuilt graph whose
  // natural node order differs. A total order makes an offset mean the same thing on
  // both. (Set iteration is insertion-ordered, so within one graph it is already
  // deterministic — the rebuild is the case this defends.)
  const matched = [...r.nodeIds]
    .map((id) => byId.get(id))
    // Defensive: an id the query returned that isn't in `graph.nodes` shouldn't
    // happen (both come from the same graph), but dropping it silently would make
    // matchCount overstate the pageable total, so it's reconciled below.
    .filter((n): n is GraphNode => n !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = Math.min(offset, matched.length);
  const nodes = matched.slice(start, start + limit).map(briefNode);
  const unknown = unknownQueryFields(query);
  return {
    query,
    scannedAt: d.scannedAt,
    // matched.length, not r.nodeIds.size: `hasMore` pages against the former, and a
    // caller looping `while (offset < matchCount)` must agree with it.
    matchCount: matched.length,
    returned: nodes.length,
    offset: start,
    hasMore: start + nodes.length < matched.length,
    empty: r.empty,
    ...(unknown.length ? { unknownFields: unknown } : {}),
    nodes,
  };
}

// --- node -------------------------------------------------------------------

export type NodeDetail = {
  node: GraphNode;
  scannedAt: number;
  dependencyCount: number;
  dependentCount: number;
  dependencies: {
    kind: string;
    target: string;
    targetLabel: string;
    count: number;
    confidence: string;
  }[];
  dependents: {
    kind: string;
    source: string;
    sourceLabel: string;
    count: number;
    confidence: string;
  }[];
};

export async function nodeDetail(path: string, id: string): Promise<NodeDetail> {
  const d = await getScan(path);
  const node = d.graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(unknownNodeMessage(id));
  const labelById = new Map(d.graph.nodes.map((n) => [n.id, n.label]));
  const out = d.graph.edges.filter((e) => e.source === id);
  const inc = d.graph.edges.filter((e) => e.target === id);
  return {
    node,
    scannedAt: d.scannedAt,
    dependencyCount: out.length,
    dependentCount: inc.length,
    dependencies: out.slice(0, EDGE_CAP).map((e) => ({
      kind: e.kind,
      target: e.target,
      targetLabel: labelById.get(e.target) ?? e.target,
      count: e.count,
      confidence: edgeConfidence(e),
    })),
    dependents: inc.slice(0, EDGE_CAP).map((e) => ({
      kind: e.kind,
      source: e.source,
      sourceLabel: labelById.get(e.source) ?? e.source,
      count: e.count,
      confidence: edgeConfidence(e),
    })),
  };
}

// --- insights ---------------------------------------------------------------

export type InsightList = {
  scannedAt: number;
  total: number;
  byKind: Record<string, number>;
  insights: {
    kind: string;
    severity: string;
    title: string;
    detail: string;
    /** Total members, so a 40-node cycle isn't reported as a 10-node one. */
    nodeIdTotal: number;
    nodeIds: string[];
  }[];
};

export async function listInsights(
  path: string,
  severity?: "info" | "warning",
): Promise<InsightList> {
  const d = await getScan(path);
  let insights = [...analyzeInsights(d.graph), ...unresolvedToInsights(d.unresolved)];
  if (severity) insights = insights.filter((i) => i.severity === severity);
  return {
    scannedAt: d.scannedAt,
    total: insights.length,
    byKind: histogram(insights.map((i) => i.kind)),
    insights: insights.slice(0, LIST_CAP).map((i) => ({
      kind: i.kind,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      nodeIdTotal: i.nodeIds.length,
      nodeIds: i.nodeIds.slice(0, NODE_ID_CAP),
    })),
  };
}

// --- check ------------------------------------------------------------------

export type CheckResult = {
  config: string;
  total: number;
  errors: number;
  warnings: number;
  violations: {
    ruleName: string;
    kind: string;
    severity: string;
    message: string;
    filePath: string;
    line: number;
  }[];
  /** SARIF 2.1.0 log, only when `format: "sarif"` was requested (for CI upload). */
  sarif?: string;
};

export async function checkRules(
  path: string,
  configPath?: string,
  format: "json" | "sarif" = "json",
): Promise<CheckResult> {
  const cfg = configPath ?? join(rootKey(path), ".polygraph.yml");
  const config = await loadConfigFile(cfg).catch((err: unknown) => {
    const m = errMsg(err);
    // loadConfigFile fails three distinct ways. Only "not found" is fixed by
    // supplying a path or creating a file; telling an agent to "add a .polygraph.yml"
    // when the file exists but has a YAML or schema error invites it to create a
    // duplicate or re-pass the same path.
    const remedy = /not found/i.test(m)
      ? `Pass {"config":"<path>"} or add a .polygraph.yml.`
      : `The config was found but is invalid — fix it at the location reported above.`;
    throw new Error(`Could not load PolyGraph config at "${cfg}": ${m}. ${remedy}`);
  });
  const d = await getScan(path);
  const violations = evaluate(config, d.graph);
  return {
    config: cfg,
    total: violations.length,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warning").length,
    violations: violations.slice(0, LIST_CAP).map((v) => ({
      ruleName: v.ruleName,
      kind: v.kind,
      severity: v.severity,
      message: v.message,
      filePath: v.location.filePath,
      line: v.location.line,
    })),
    ...(format === "sarif" ? { sarif: toSarifString(violations) } : {}),
  };
}

// --- diff -------------------------------------------------------------------

export type DiffResult = {
  base: string;
  head: string;
  summary: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
    edgesAdded: number;
    edgesRemoved: number;
    newCycles: number;
    removedCycles: number;
  };
  addedNodes: BriefNode[];
  removedNodes: BriefNode[];
  newCycles: { members: string[] }[];
  /** Total moved nodes, of which `blastRadius` lists the largest few. */
  blastRadiusTotal: number;
  blastRadius: { label: string; delta: number }[];
};

export async function diffRevisions(
  path: string,
  base: string,
  head?: string,
): Promise<DiffResult> {
  const root = rootKey(path);
  // diffGraphs (a pure function) stays outside the try so a bug there surfaces
  // unmodified. Note scanRevision/scanTarget are NOT just git: they resolve the
  // revision, then scan and analyze it. So the guidance has to be keyed on the
  // actual cause — appending "check your revisions" to an analyzer crash sends an
  // agent into retrying revisions that were never the problem.
  let before: ScanResult;
  let after: ScanResult;
  try {
    before = await scanRevision(root, base);
    after = await scanTarget(root, head ?? WORKING_TREE);
  } catch (err) {
    const m = errMsg(err);
    const isRevision = /revision|not a git repository|unknown revision|ambiguous argument/i.test(m);
    const hint = isRevision
      ? `Diff needs a git repo and valid revisions (a base, and optionally a head — omit head to compare against the working tree).`
      : `The revisions resolved, but scanning or analyzing one of them failed — this is not a revision problem, so retrying with different revisions will not help.`;
    throw new Error(
      `Diff of "${root}" (${base} → ${head ?? "working tree"}) failed: ${m}. ${hint}`,
    );
  }
  const diff = diffGraphs(before.graph, after.graph, before.label, after.label);
  return {
    base: diff.base,
    head: diff.head,
    summary: diff.summary,
    addedNodes: diff.nodes.added.slice(0, NODE_CAP).map(briefNode),
    removedNodes: diff.nodes.removed.slice(0, NODE_CAP).map(briefNode),
    newCycles: diff.newCycles.slice(0, CYCLE_CAP).map((c) => ({ members: c.labels })),
    blastRadiusTotal: diff.blastRadiusDeltas.length,
    blastRadius: diff.blastRadiusDeltas
      .slice(0, CYCLE_CAP)
      .map((b) => ({ label: b.label, delta: b.delta })),
  };
}

// --- read (source within scanned roots) -------------------------------------

const MAX_LINES = 800;

export type FileSlice = {
  file: string;
  scannedAt: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
};

/**
 * Read a slice of a source file — but ONLY a file PolyGraph already analyzed under
 * `path`, and ONLY if it resolves (canonicalized) inside that scanned root. Two
 * independent gates: graph membership (so it's a real source file that passed the
 * scanner's extension/ignore filters — excludes node_modules, build output, and
 * non-source files like a bare .env; note source files such as .json/.sql ARE in
 * scope, so this bounds reads to the analyzed source set rather than being a
 * secrets firewall) and a realpath containment check (defeats `../` and symlink
 * escapes). The deliberate guard against an LLM being steered into reading
 * arbitrary files.
 */
export async function readSource(
  path: string,
  file: string,
  startLine?: number,
  endLine?: number,
): Promise<FileSlice> {
  const d = await getScan(path);
  const isScanned = d.graph.nodes.some((n) => n.kind === "file" && n.id === file);
  if (!isScanned) {
    throw new Error(
      `"${file}" is not a scanned source file under ${d.root}. List readable files with polygraph_query {"query":"kind:file"}.`,
    );
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new Error(
      `Invalid line range for "${file}": endLine (${endLine}) is before startLine (${startLine}).`,
    );
  }
  const root = rootKey(path);
  // The graph just promised this file exists, so a filesystem failure here means the
  // cached scan no longer matches disk — say that, rather than leaking a bare errno
  // that contradicts the tool the caller used to find the file.
  let realFile: string;
  let realRoot: string;
  try {
    [realFile, realRoot] = await Promise.all([realpath(resolve(root, file)), realpath(root)]);
  } catch (err) {
    throw new Error(
      `"${file}" is in the cached graph but is no longer readable on disk (${errMsg(err)}). The scan may be stale — re-run polygraph_scan {"path":"${root}"}.`,
    );
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    throw new Error(`Refusing to read "${file}": it resolves outside the scanned root.`);
  }

  let text: string;
  try {
    text = await readFile(realFile, "utf8");
  } catch (err) {
    throw new Error(
      `"${file}" is in the cached graph but could not be read (${errMsg(err)}). The scan may be stale — re-run polygraph_scan {"path":"${root}"}.`,
    );
  }
  const lines = text.split("\n");
  // split("\n") yields a trailing "" for the newline every well-formed file ends
  // with; counting it would report every such file as one line longer than it is.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const from = Math.min(Math.max(1, startLine ?? 1), Math.max(1, total));
  const to = Math.min(endLine ?? total, total);
  const slice = lines.slice(from - 1, Math.max(from, to));
  const truncated = slice.length > MAX_LINES;
  return {
    file,
    scannedAt: d.scannedAt,
    startLine: from,
    endLine: truncated ? from + MAX_LINES - 1 : Math.max(from, to),
    totalLines: total,
    truncated,
    content: (truncated ? slice.slice(0, MAX_LINES) : slice).join("\n"),
  };
}

// --- logs (live telemetry: read + control) ----------------------------------

export type LogEvent = {
  t: number;
  category: string;
  level: string;
  event: string;
  data?: Record<string, unknown>;
};
// Identical to the telemetry bus's own summary type — alias it rather than keep a
// second copy that can drift.
export type MetricSummary = HistogramSummary;
export type LogsAction = "tail" | "metrics" | "status" | "enable" | "disable" | "clear";
export type LogsMetrics = {
  histograms: Record<string, MetricSummary>;
  counters: Record<string, number>;
};
type LogsBase = { enabled: boolean; eventCount: number };
export type LogsTail = LogsBase & { action: "tail"; events: LogEvent[] };
export type LogsMetricsResult = LogsBase & { action: "metrics"; metrics: LogsMetrics };
export type LogsStatus = LogsBase & { action: "status" | "enable" | "disable" | "clear" };
/**
 * Discriminated on `action` so the payload can't disagree with it: `tail` always
 * carries `events`, `metrics` always carries `metrics`, and the control actions
 * carry neither (rather than every field being independently optional).
 */
export type LogsResult = LogsTail | LogsMetricsResult | LogsStatus;

/**
 * Read and control the live telemetry bus (lib/telemetry) of THIS server process:
 * `tail` recent events, `metrics` rolling histograms + counters, `status`, or the
 * control actions `enable`/`disable`/`clear`. The MCP tools emit their own activity
 * here, so `tail` is a live log of what the agent has been doing.
 *
 * Overloaded so a literal action yields its exact variant (`logs("tail").events`
 * needs no narrowing); a dynamic action still returns the full union.
 */
export function logs(action: "tail", limit?: number): LogsTail;
export function logs(action: "metrics", limit?: number): LogsMetricsResult;
export function logs(action: "status" | "enable" | "disable" | "clear"): LogsStatus;
export function logs(action?: LogsAction, limit?: number): LogsResult;
export function logs(action: LogsAction = "tail", limit = 50): LogsResult {
  if (action === "enable") telemetry.setEnabled(true);
  else if (action === "disable") telemetry.setEnabled(false);
  else if (action === "clear") telemetry.clearAll();

  const snap = telemetry.snapshot();
  const base: LogsBase = { enabled: snap.enabled, eventCount: telemetry.eventCount() };
  if (action === "metrics") return { ...base, action, metrics: snap.metrics };
  if (action === "tail") {
    const events = snap.events.slice(-limit).map((e) => ({
      t: e.t,
      category: e.category,
      level: e.level,
      event: e.event,
      ...(e.data ? { data: e.data } : {}),
    }));
    return { ...base, action, events };
  }
  return { ...base, action }; // status / enable / disable / clear
}

// --- impact (blast radius) ---------------------------------------------------

export type ImpactResult = {
  id: string;
  scannedAt: number;
  label: string;
  /** Transitive dependents — everything that could break if `id` changes. */
  total: number;
  byPackage: Record<string, number>;
  byKind: Record<string, number>;
  /** How many files are affected in all; `topFiles` lists the worst few. (`total` counts nodes, a different denominator.) */
  filesAffected: number;
  topFiles: { file: string; affected: number }[];
};

/** "What breaks if I change this?" — the transitive dependent set, grouped. */
export async function impactOf(path: string, id: string): Promise<ImpactResult> {
  const d = await getScan(path);
  const node = d.graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(unknownNodeMessage(id));
  const b = blastRadius(d.graph, id);
  return {
    id,
    scannedAt: d.scannedAt,
    label: node.label,
    total: b.total,
    byPackage: b.byPackage,
    byKind: b.byKind,
    filesAffected: Object.keys(b.byFile).length,
    topFiles: Object.entries(b.byFile)
      .sort((a, z) => z[1] - a[1] || (a[0] < z[0] ? -1 : 1))
      .slice(0, NODE_CAP)
      .map(([file, affected]) => ({ file, affected })),
  };
}

// --- path (how does A reach B?) ----------------------------------------------

export type PathResult = {
  from: string;
  to: string;
  scannedAt: number;
  connected: boolean;
  /** Number of edges traversed; 0 when `from` === `to` or unconnected. */
  hops: number;
  path: { id: string; label: string }[];
  edges: { source: string; target: string; kind: string }[];
};

/** Explain the shortest dependency path from one node to another. */
export async function pathBetween(path: string, from: string, to: string): Promise<PathResult> {
  const d = await getScan(path);
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  for (const id of [from, to]) if (!byId.has(id)) throw new Error(unknownNodeMessage(id));
  const c = whyConnected(d.graph, from, to);
  if (!c) {
    return { from, to, scannedAt: d.scannedAt, connected: false, hops: 0, path: [], edges: [] };
  }
  return {
    from,
    to,
    scannedAt: d.scannedAt,
    connected: true,
    hops: Math.max(0, c.path.length - 1),
    path: c.path.map((id) => ({ id, label: byId.get(id)?.label ?? id })),
    edges: c.edges,
  };
}
