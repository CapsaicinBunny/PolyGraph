// The eight PolyGraph operations the MCP tools expose, returning structured data.
// Deliberately free of any MCP/SDK types so they're unit-testable directly against
// a fixture; mcp/server.ts wraps each one as a tool.

import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type ScanResult, scanRevision, scanTarget, WORKING_TREE } from "../lib/cli/scan";
import { loadConfigFile } from "../lib/config/load";
import { diffGraphs } from "../lib/diff/diff";
import { analyzeInsights, unresolvedToInsights } from "../lib/graph/insights";
import { runQuery } from "../lib/graph/query-language";
import type { GraphNode } from "../lib/graph/types";
import { evaluate } from "../lib/rules/engine";
import type { HistogramSummary } from "../lib/telemetry";
import { getScan, rootKey } from "./cache";
import { type BriefNode, briefNode, edgeConfidence, errMsg, histogram } from "./format";
import { telemetry } from "./telemetry";

const LIST_CAP = 100;
const EDGE_CAP = 50;
const NODE_CAP = 30;

// Result types below are `type` aliases, not interfaces: the MCP SDK's
// `structuredContent` requires assignability to `{ [k: string]: unknown }`, which
// object-literal type aliases get implicitly but interfaces do not. (BriefNode in
// format.ts stays an interface — it's only ever nested, never assigned directly.)

// --- scan -------------------------------------------------------------------

export type ScanSummary = {
  root: string;
  fileCount: number;
  skipped: number;
  nodeCount: number;
  edgeCount: number;
  parseWarnings: number;
  unresolved: number;
  nodeKinds: Record<string, number>;
  edgeKinds: Record<string, number>;
  edgeConfidence: Record<string, number>;
  packages: { id: string; ecosystem: string }[];
  scanMs: number;
  analyzeMs: number;
};

export async function scanSummary(path: string): Promise<ScanSummary> {
  const d = await getScan(path, { refresh: true });
  return {
    root: d.root,
    fileCount: d.fileCount,
    skipped: d.skipped,
    nodeCount: d.graph.nodes.length,
    edgeCount: d.graph.edges.length,
    parseWarnings: d.errors.length,
    unresolved: d.unresolved.length,
    nodeKinds: histogram(d.graph.nodes.map((n) => n.kind)),
    edgeKinds: histogram(d.graph.edges.map((e) => e.kind)),
    edgeConfidence: histogram(d.graph.edges.map(edgeConfidence)),
    packages: d.manifests.slice(0, LIST_CAP).map((m) => ({ id: m.id, ecosystem: m.ecosystem })),
    scanMs: Math.round(d.timings.scanMs),
    analyzeMs: Math.round(d.timings.analyzeMs),
  };
}

// --- query ------------------------------------------------------------------

export type QueryNodes = {
  query: string;
  matchCount: number;
  returned: number;
  empty: boolean;
  error?: string;
  nodes: BriefNode[];
};

export async function queryNodes(path: string, query: string, limit = 50): Promise<QueryNodes> {
  const d = await getScan(path);
  const r = runQuery(d.graph, query);
  if (r.error) {
    return { query, matchCount: 0, returned: 0, empty: r.empty, error: r.error, nodes: [] };
  }
  const byId = new Map(d.graph.nodes.map((n) => [n.id, n]));
  const nodes = [...r.nodeIds]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => n !== undefined)
    .slice(0, limit)
    .map(briefNode);
  return { query, matchCount: r.nodeIds.size, returned: nodes.length, empty: r.empty, nodes };
}

// --- node -------------------------------------------------------------------

export type NodeDetail = {
  node: GraphNode;
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
  if (!node) {
    throw new Error(
      `No node with id "${id}". Discover ids with polygraph_query — e.g. {"query":"path:**/<file>"} or {"query":"kind:file"} — then use a returned node's id.`,
    );
  }
  const labelById = new Map(d.graph.nodes.map((n) => [n.id, n.label]));
  const out = d.graph.edges.filter((e) => e.source === id);
  const inc = d.graph.edges.filter((e) => e.target === id);
  return {
    node,
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
  total: number;
  byKind: Record<string, number>;
  insights: { kind: string; severity: string; title: string; detail: string; nodeIds: string[] }[];
};

export async function listInsights(
  path: string,
  severity?: "info" | "warning",
): Promise<InsightList> {
  const d = await getScan(path);
  let insights = [...analyzeInsights(d.graph), ...unresolvedToInsights(d.unresolved)];
  if (severity) insights = insights.filter((i) => i.severity === severity);
  return {
    total: insights.length,
    byKind: histogram(insights.map((i) => i.kind)),
    insights: insights.slice(0, LIST_CAP).map((i) => ({
      kind: i.kind,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      nodeIds: i.nodeIds.slice(0, 10),
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
};

export async function checkRules(path: string, configPath?: string): Promise<CheckResult> {
  const cfg = configPath ?? join(rootKey(path), ".polygraph.yml");
  const config = await loadConfigFile(cfg).catch((err: unknown) => {
    throw new Error(
      `Could not load PolyGraph config at "${cfg}": ${errMsg(err)}. Pass {"config":"<path>"} or add a .polygraph.yml.`,
    );
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
  blastRadius: { label: string; delta: number }[];
};

export async function diffRevisions(
  path: string,
  base: string,
  head?: string,
): Promise<DiffResult> {
  const root = rootKey(path);
  // Wrap ONLY the git/revision acquisition: a bug in diffGraphs (a pure function)
  // must surface unmodified, not get mislabeled as a git/revision problem.
  let before: ScanResult;
  let after: ScanResult;
  try {
    before = await scanRevision(root, base);
    after = await scanTarget(root, head ?? WORKING_TREE);
  } catch (err) {
    throw new Error(
      `Could not read revisions to diff under "${root}": ${errMsg(err)}. Diff needs a git repo and valid revisions (a base, and optionally a head — omit head to compare against the working tree).`,
    );
  }
  const diff = diffGraphs(before.graph, after.graph, before.label, after.label);
  return {
    base: diff.base,
    head: diff.head,
    summary: diff.summary,
    addedNodes: diff.nodes.added.slice(0, NODE_CAP).map(briefNode),
    removedNodes: diff.nodes.removed.slice(0, NODE_CAP).map(briefNode),
    newCycles: diff.newCycles.slice(0, 10).map((c) => ({ members: c.labels })),
    blastRadius: diff.blastRadiusDeltas
      .slice(0, 10)
      .map((b) => ({ label: b.label, delta: b.delta })),
  };
}

// --- read (source within scanned roots) -------------------------------------

const MAX_LINES = 800;

export type FileSlice = {
  file: string;
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
  const root = rootKey(path);
  const [realFile, realRoot] = await Promise.all([realpath(resolve(root, file)), realpath(root)]);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    throw new Error(`Refusing to read "${file}": it resolves outside the scanned root.`);
  }

  const lines = (await readFile(realFile, "utf8")).split("\n");
  const total = lines.length;
  const from = Math.min(Math.max(1, startLine ?? 1), total);
  const to = Math.min(endLine ?? total, total);
  const slice = lines.slice(from - 1, Math.max(from, to));
  const truncated = slice.length > MAX_LINES;
  return {
    file,
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
export type LogsResult = {
  action: LogsAction;
  enabled: boolean;
  eventCount: number;
  events?: LogEvent[];
  metrics?: { histograms: Record<string, MetricSummary>; counters: Record<string, number> };
};

/**
 * Read and control the live telemetry bus (lib/telemetry) of THIS server process:
 * `tail` recent events, `metrics` rolling histograms + counters, `status`, or the
 * control actions `enable`/`disable`/`clear`. The MCP tools emit their own activity
 * here, so `tail` is a live log of what the agent has been doing.
 */
export function logs(action: LogsAction = "tail", limit = 50): LogsResult {
  if (action === "enable") telemetry.setEnabled(true);
  else if (action === "disable") telemetry.setEnabled(false);
  else if (action === "clear") telemetry.clearAll();

  const snap = telemetry.snapshot();
  const base = { action, enabled: snap.enabled, eventCount: telemetry.eventCount() };
  if (action === "metrics") return { ...base, metrics: snap.metrics };
  if (action === "tail") {
    const events = snap.events.slice(-limit).map((e) => ({
      t: e.t,
      category: e.category,
      level: e.level,
      event: e.event,
      ...(e.data ? { data: e.data } : {}),
    }));
    return { ...base, events };
  }
  return base; // status / enable / disable / clear
}
