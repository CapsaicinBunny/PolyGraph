// The architecture-rule engine: evaluate a normalized PolygraphConfig against a
// GraphModel and produce a flat list of Violations. Pure and deterministic —
// the CLI, SARIF writer, and baseline differ all build on this one function.

import { buildAdjacency } from "../graph/query";
import type { GraphModel, GraphNode } from "../graph/types";
import { stronglyConnectedComponents } from "../layout/scc";
import type { PolygraphConfig, Severity } from "../config/schema";
import { matchNode } from "./selector";

export type ViolationKind = "dependency" | "cycle" | "fan-out" | "depth";

export interface ViolationLocation {
  filePath: string;
  /** 1-based line; 1 when only a file-level location is known. */
  line: number;
}

export interface Violation {
  /** The configured rule name, or a synthetic name for threshold breaches. */
  ruleName: string;
  kind: ViolationKind;
  severity: Severity;
  message: string;
  location: ViolationLocation;
  /** Other nodes implicated (cycle members, the disallowed target, …). */
  related: { filePath: string; line: number; label: string }[];
}

/** Stable, position-tolerant identity of a violation — used for baseline diffing. */
export function fingerprint(v: Violation): string {
  const rel = v.related
    .map((r) => `${r.filePath}:${r.label}`)
    .sort()
    .join(",");
  return `${v.kind}|${v.ruleName}|${v.location.filePath}|${rel}`;
}

function startLine(node: GraphNode): number {
  return node.line > 0 ? node.line : 1;
}

/** Distinct out-neighbor count per node id (multiple edge kinds count once). */
function fanOut(graph: GraphModel): Map<string, number> {
  const { out } = buildAdjacency(graph);
  const counts = new Map<string, number>();
  for (const [id, edges] of out) {
    counts.set(id, new Set(edges.map((e) => e.id)).size);
  }
  return counts;
}

/**
 * Longest dependency chain (node count) over the acyclic SCC condensation,
 * returned as representative node ids. Iterative post-order DFS so deep graphs
 * don't overflow the stack — mirrors lib/graph/insights.ts and lib/layout/scc.ts.
 */
function longestChain(graph: GraphModel): string[] {
  const ids = graph.nodes.map((n) => n.id);
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
  const cadj = new Map<string, Set<string>>();
  for (const scc of sccs) cadj.set(scc.id, new Set());
  for (const e of graph.edges) {
    const a = sccOf.get(e.source);
    const b = sccOf.get(e.target);
    if (a && b && a !== b) cadj.get(a)?.add(b);
  }

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

/** Evaluate every rule and threshold against the graph. Deterministic ordering. */
export function evaluate(config: PolygraphConfig, graph: GraphModel): Violation[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const violations: Violation[] = [];

  for (const rule of config.rules) {
    if (rule.type === "dependency") {
      // One violation per (source file → target file) pair, pointing at the most
      // precise location we have (the edge's first recorded occurrence).
      const seen = new Set<string>();
      for (const edge of graph.edges) {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) continue;
        if (!matchNode(rule.from, source) || !matchNode(rule.disallow, target)) continue;

        const key = `${source.parentFile}->${target.parentFile}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const occ = edge.occurrences[0];
        const loc: ViolationLocation = occ
          ? { filePath: occ.filePath, line: occ.line }
          : { filePath: source.filePath, line: startLine(source) };
        violations.push({
          ruleName: rule.name,
          kind: "dependency",
          severity: rule.severity,
          message: `${source.label} (${source.parentFile}) must not depend on ${target.label} (${target.parentFile})`,
          location: loc,
          related: [{ filePath: target.filePath, line: startLine(target), label: target.label }],
        });
      }
    } else {
      // Cycle rule. Flag SCCs of >1 member; when scoped, only those whose every
      // member falls inside the scope.
      const sccs = stronglyConnectedComponents(
        graph.nodes.map((n) => n.id),
        graph.edges.map((e) => ({ source: e.source, target: e.target })),
      );
      for (const scc of sccs) {
        if (scc.members.length < 2) continue;
        const members = scc.members
          .map((id) => nodeById.get(id))
          .filter((n): n is GraphNode => !!n);
        if (rule.scope && !members.every((n) => matchNode(rule.scope!, n))) continue;
        const head = members[0];
        violations.push({
          ruleName: rule.name,
          kind: "cycle",
          severity: rule.severity,
          message: `Circular dependency (${members.length} nodes): ${members.map((n) => n.label).join(" → ")}`,
          location: { filePath: head.filePath, line: startLine(head) },
          related: members.map((n) => ({
            filePath: n.filePath,
            line: startLine(n),
            label: n.label,
          })),
        });
      }
    }
  }

  const { maxFanOut, maxDependencyDepth, severity } = config.thresholds;

  if (maxFanOut !== undefined) {
    const counts = fanOut(graph);
    for (const node of graph.nodes) {
      const c = counts.get(node.id) ?? 0;
      if (c > maxFanOut) {
        violations.push({
          ruleName: "maxFanOut",
          kind: "fan-out",
          severity,
          message: `${node.label} (${node.parentFile}) has fan-out ${c}, exceeding maxFanOut ${maxFanOut}`,
          location: { filePath: node.filePath, line: startLine(node) },
          related: [],
        });
      }
    }
  }

  if (maxDependencyDepth !== undefined) {
    const chain = longestChain(graph);
    if (chain.length > maxDependencyDepth) {
      const nodes = chain.map((id) => nodeById.get(id)).filter((n): n is GraphNode => !!n);
      const head = nodes[0];
      violations.push({
        ruleName: "maxDependencyDepth",
        kind: "depth",
        severity,
        message: `Longest dependency chain is ${chain.length} levels, exceeding maxDependencyDepth ${maxDependencyDepth}`,
        location: head
          ? { filePath: head.filePath, line: startLine(head) }
          : { filePath: "", line: 1 },
        related: nodes.map((n) => ({ filePath: n.filePath, line: startLine(n), label: n.label })),
      });
    }
  }

  return violations;
}

/** Split violations by severity. */
export function countBySeverity(violations: Violation[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const v of violations) {
    if (v.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}
