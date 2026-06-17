// Pure architectural-issue detectors over a GraphModel. Each finding is an Insight
// whose `nodeIds` define a focused subgraph the UI can open. Language-agnostic.

import { stronglyConnectedComponents } from "../layout/scc";
import { buildAdjacency } from "./query";
import type { GraphModel, UnresolvedRef } from "./types";

export type InsightKind =
  | "cycle"
  | "fan-in"
  | "fan-out"
  | "bottleneck"
  | "orphan"
  | "client-server"
  | "undeclared"
  | "deep-chain"
  | "instability"
  | "ambiguous"
  | "unresolved";

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

  // 9. Instability (SDP) violations: a stable module depending on a less-stable one.
  // Martin's metric is about *coupling*, so compute it over import edges only
  // (mixing call/extends/renders degrees would make I swing for unrelated reasons).
  let unstable = 0;
  const impOut = new Map<string, number>();
  const impIn = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind !== "import") continue;
    impOut.set(e.source, (impOut.get(e.source) ?? 0) + 1);
    impIn.set(e.target, (impIn.get(e.target) ?? 0) + 1);
  }
  const instability = (id: string): number => {
    const ce = impOut.get(id) ?? 0;
    const ca = impIn.get(id) ?? 0;
    return ca + ce === 0 ? 0 : ce / (ca + ce);
  };
  for (const e of graph.edges) {
    if (e.kind !== "import") continue;
    const si = instability(e.source);
    const ti = instability(e.target);
    const deg = (impOut.get(e.source) ?? 0) + (impIn.get(e.source) ?? 0);
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

  // 10. Ambiguous resolutions — a reference that resolved to more than one candidate
  // (its evidence is marked "ambiguous"). The drawn target may not be the real one.
  let ambiguous = 0;
  for (const e of graph.edges) {
    if (e.occurrences.some((o) => o.confidence === "ambiguous") && ambiguous++ < MAX_PER_KIND) {
      insights.push({
        id: `ambiguous:${e.id}`,
        kind: "ambiguous",
        severity: "warning",
        title: `Ambiguous ${e.kind}: ${nodeById.get(e.source)?.label ?? e.source} → ${nodeById.get(e.target)?.label ?? e.target}`,
        detail: "Resolved to one of several candidates — the drawn target may be wrong.",
        nodeIds: [e.source, e.target],
      });
    }
  }

  return insights;
}

/**
 * Convert unresolved references (gathered by the analyzer, not derived from the
 * graph) into Insights so the Problems panel can show "what PolyGraph couldn't
 * prove" alongside the graph-derived findings. Clicking one focuses its file.
 */
export function unresolvedToInsights(refs: UnresolvedRef[]): Insight[] {
  return refs.slice(0, MAX_PER_KIND).map((r) => ({
    id: `unresolved:${r.sourceId}:${r.name}:${r.line}`,
    kind: "unresolved",
    severity: "warning",
    title: `Unresolved import "${r.name}" in ${r.filePath}`,
    detail: `Line ${r.line} — points to no file in the scanned set.`,
    nodeIds: [r.sourceId],
  }));
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
  // Longest path via explicit-stack post-order DFS (iterative — the condensation
  // can be a deep line of singletons, so recursion would overflow the stack on
  // large graphs, the same hazard lib/layout/scc.ts avoids).
  const best = new Map<string, string[]>();
  for (const root of sccs.map((s) => s.id)) {
    if (best.has(root)) continue;
    const work: { node: string; i: number; succ: string[] }[] = [
      { node: root, i: 0, succ: [...(cadj.get(root) ?? [])].sort() },
    ];
    while (work.length > 0) {
      const f = work[work.length - 1];
      if (f.i < f.succ.length) {
        const nb = f.succ[f.i++];
        if (!best.has(nb)) work.push({ node: nb, i: 0, succ: [...(cadj.get(nb) ?? [])].sort() });
      } else {
        let longest: string[] = [];
        for (const nb of f.succ) {
          const sub = best.get(nb) ?? [];
          if (sub.length > longest.length) longest = sub;
        }
        best.set(f.node, [f.node, ...longest]);
        work.pop();
      }
    }
  }
  let overall: string[] = [];
  for (const scc of sccs) {
    const p = best.get(scc.id) ?? [];
    if (p.length > overall.length) overall = p;
  }
  return overall.map((sccId) => repOf.get(sccId) as string);
}
