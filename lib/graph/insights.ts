// Pure architectural-issue detectors over a GraphModel. Each finding is an Insight
// whose `nodeIds` define a focused subgraph the UI can open. Language-agnostic.

import { stronglyConnectedComponents } from "../layout/scc";
import { buildAdjacency } from "./query";
import type { GraphModel } from "./types";

export type InsightKind =
  | "cycle"
  | "fan-in"
  | "fan-out"
  | "bottleneck"
  | "orphan"
  | "client-server"
  | "undeclared"
  | "deep-chain"
  | "instability";

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: "info" | "warning";
  title: string;
  detail: string;
  nodeIds: string[];
}

// Tunable thresholds.
const DEGREE_FLOOR = 6; // a node needs at least this degree to be an outlier at all
const SIGMA = 2; // outlier = mean + SIGMA * stddev
const DEEP_CHAIN_MIN = 6; // chain length (nodes) to flag
const INSTABILITY_MARGIN = 0.3; // SDP: flag when I(target) - I(source) exceeds this
const MAX_PER_KIND = 50; // bound output per detector

/** Threshold above which a degree counts as an outlier (mean + SIGMA·σ, floored). */
function outlierThreshold(values: number[]): number {
  const nonzero = values.filter((v) => v > 0);
  if (nonzero.length === 0) return Infinity;
  const mean = nonzero.reduce((a, b) => a + b, 0) / nonzero.length;
  const variance = nonzero.reduce((a, b) => a + (b - mean) ** 2, 0) / nonzero.length;
  return Math.max(DEGREE_FLOOR, mean + SIGMA * Math.sqrt(variance));
}

/** Detect architectural issues. Deterministic; safe on any GraphModel. */
export function analyzeInsights(graph: GraphModel): Insight[] {
  const insights: Insight[] = [];
  const { out, inc } = buildAdjacency(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const ids = graph.nodes.map((n) => n.id).sort();

  // 1. Circular dependencies (SCCs with >1 member).
  for (const scc of stronglyConnectedComponents(
    ids,
    graph.edges.map((e) => ({ source: e.source, target: e.target })),
  )) {
    if (scc.members.length < 2) continue;
    insights.push({
      id: `cycle:${scc.id}`,
      kind: "cycle",
      severity: "warning",
      title: `Circular dependency (${scc.members.length} nodes)`,
      detail: scc.members.map((m) => nodeById.get(m)?.label ?? m).join(" → "),
      nodeIds: scc.members,
    });
  }

  // 2/3. Fan-out / fan-in outliers.
  const outDeg = ids.map((id) => (out.get(id) ?? []).length);
  const incDeg = ids.map((id) => (inc.get(id) ?? []).length);
  const outThr = outlierThreshold(outDeg);
  const incThr = outlierThreshold(incDeg);
  let fanOut = 0;
  let fanIn = 0;
  for (const id of ids) {
    const o = (out.get(id) ?? []).length;
    if (o >= outThr && fanOut++ < MAX_PER_KIND) {
      insights.push({
        id: `fan-out:${id}`,
        kind: "fan-out",
        severity: "info",
        title: `High fan-out: ${nodeById.get(id)?.label ?? id} (${o})`,
        detail: `Depends on ${o} other nodes.`,
        nodeIds: [id, ...(out.get(id) ?? []).map((e) => e.id)],
      });
    }
    const i = (inc.get(id) ?? []).length;
    if (i >= incThr && fanIn++ < MAX_PER_KIND) {
      insights.push({
        id: `fan-in:${id}`,
        kind: "fan-in",
        severity: "info",
        title: `High fan-in: ${nodeById.get(id)?.label ?? id} (${i})`,
        detail: `${i} nodes depend on this.`,
        nodeIds: [id, ...(inc.get(id) ?? []).map((e) => e.id)],
      });
    }
  }

  // 4. Bottlenecks — chokepoints with both high fan-in and high fan-out.
  let bottlenecks = 0;
  for (const id of ids) {
    const o = (out.get(id) ?? []).length;
    const i = (inc.get(id) ?? []).length;
    if (i >= incThr && o >= outThr && bottlenecks++ < MAX_PER_KIND) {
      insights.push({
        id: `bottleneck:${id}`,
        kind: "bottleneck",
        severity: "warning",
        title: `Bottleneck: ${nodeById.get(id)?.label ?? id}`,
        detail: `${i} dependents and ${o} dependencies flow through this node.`,
        nodeIds: [
          id,
          ...(out.get(id) ?? []).map((e) => e.id),
          ...(inc.get(id) ?? []).map((e) => e.id),
        ],
      });
    }
  }

  // 5. Orphaned / isolated nodes (degree 0), aggregated into one finding.
  const orphans = ids.filter((id) => (out.get(id) ?? []).length + (inc.get(id) ?? []).length === 0);
  if (orphans.length > 0) {
    insights.push({
      id: "orphan:all",
      kind: "orphan",
      severity: "info",
      title: `${orphans.length} isolated node${orphans.length === 1 ? "" : "s"}`,
      detail: "Nodes with no incoming or outgoing relationships.",
      nodeIds: orphans,
    });
  }

  // 6. Client → server violations: a client file importing a server file.
  let csViolations = 0;
  for (const e of graph.edges) {
    if (e.kind !== "import") continue;
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (
      s?.environment === "client" &&
      t?.environment === "server" &&
      csViolations++ < MAX_PER_KIND
    ) {
      insights.push({
        id: `client-server:${e.id}`,
        kind: "client-server",
        severity: "warning",
        title: `Client imports server: ${s.label} → ${t.label}`,
        detail: "Client-side code imports a server-only module.",
        nodeIds: [e.source, e.target],
      });
    }
  }

  // 7. Undeclared dependencies (external packages not in package.json).
  let undeclared = 0;
  for (const n of graph.nodes) {
    if (n.kind === "external" && n.dependencyType === "undeclared" && undeclared++ < MAX_PER_KIND) {
      insights.push({
        id: `undeclared:${n.id}`,
        kind: "undeclared",
        severity: "warning",
        title: `Undeclared dependency: ${n.label}`,
        detail: "Imported but not listed in package.json.",
        nodeIds: [n.id, ...(inc.get(n.id) ?? []).map((e) => e.id)],
      });
    }
  }

  // 8. Deep dependency chain — longest path over the acyclic condensation.
  const chain = longestChain(ids, graph, out);
  if (chain.length >= DEEP_CHAIN_MIN) {
    insights.push({
      id: "deep-chain:longest",
      kind: "deep-chain",
      severity: "info",
      title: `Deep dependency chain (${chain.length} levels)`,
      detail: chain.map((m) => nodeById.get(m)?.label ?? m).join(" → "),
      nodeIds: chain,
    });
  }

  // 9. Instability (SDP) violations: a stable node depending on a less-stable one.
  let unstable = 0;
  const instability = (id: string): number => {
    const ce = (out.get(id) ?? []).length;
    const ca = (inc.get(id) ?? []).length;
    return ca + ce === 0 ? 0 : ce / (ca + ce);
  };
  for (const e of graph.edges) {
    const si = instability(e.source);
    const ti = instability(e.target);
    const deg = (out.get(e.source) ?? []).length + (inc.get(e.source) ?? []).length;
    if (ti - si > INSTABILITY_MARGIN && deg >= DEGREE_FLOOR && unstable++ < MAX_PER_KIND) {
      insights.push({
        id: `instability:${e.id}`,
        kind: "instability",
        severity: "info",
        title: `Stable→unstable dependency: ${nodeById.get(e.source)?.label ?? e.source}`,
        detail: `A more stable node depends on a less stable one (I ${si.toFixed(2)} → ${ti.toFixed(2)}).`,
        nodeIds: [e.source, e.target],
      });
    }
  }

  return insights;
}

/** Longest path over the SCC condensation, returned as representative node ids. */
function longestChain(
  ids: string[],
  graph: GraphModel,
  out: Map<string, { id: string; kind: string }[]>,
): string[] {
  const sccs = stronglyConnectedComponents(
    ids,
    graph.edges.map((e) => ({ source: e.source, target: e.target })),
  );
  const sccOf = new Map<string, string>();
  const repOf = new Map<string, string>();
  for (const scc of sccs) {
    repOf.set(scc.id, scc.members[0]);
    for (const m of scc.members) sccOf.set(m, scc.id);
  }
  // Condensation adjacency (no self-loops).
  const cadj = new Map<string, Set<string>>();
  for (const scc of sccs) cadj.set(scc.id, new Set());
  for (const [id, edges] of out) {
    const a = sccOf.get(id);
    if (!a) continue;
    for (const { id: nb } of edges) {
      const b = sccOf.get(nb);
      if (b && a !== b) cadj.get(a)?.add(b);
    }
  }
  // Longest path via memoized DFS (condensation is a DAG).
  const best = new Map<string, string[]>();
  const visiting = new Set<string>();
  const dfs = (s: string): string[] => {
    const cached = best.get(s);
    if (cached) return cached;
    if (visiting.has(s)) return [s]; // guard (shouldn't happen on a DAG)
    visiting.add(s);
    let longest: string[] = [];
    for (const nb of [...(cadj.get(s) ?? [])].sort()) {
      const sub = dfs(nb);
      if (sub.length > longest.length) longest = sub;
    }
    visiting.delete(s);
    const path = [s, ...longest];
    best.set(s, path);
    return path;
  };
  let overall: string[] = [];
  for (const scc of sccs) {
    const p = dfs(scc.id);
    if (p.length > overall.length) overall = p;
  }
  return overall.map((sccId) => repOf.get(sccId) as string);
}
