// Plain-text renderers for the CLI. Kept free of ANSI color so output is clean
// in CI logs; structured outputs (SARIF, JSON) are produced elsewhere.

import type { PolygraphConfig } from "../config/schema";
import type { GraphDiff } from "../diff/diff";
import { countBySeverity, type Violation } from "../rules/engine";

const CHECK = "✓"; // ✓
const CROSS = "✗"; // ✗
const WARN = "⚠"; // ⚠

function shortLine(v: Violation): string {
  if (v.kind === "dependency") {
    return `${v.location.filePath}:${v.location.line} → ${v.related[0]?.filePath ?? "?"}`;
  }
  if (v.kind === "cycle") return v.related.map((r) => r.label).join(" → ");
  return v.message;
}

export interface CheckReportOptions {
  root: string;
  fileCount: number;
  /** When set, violations are the *new* ones relative to this baseline rev. */
  baseline?: string;
}

/** Render a check result: per-rule pass/fail, threshold status, and a summary. */
export function formatCheck(
  config: PolygraphConfig,
  violations: Violation[],
  opts: CheckReportOptions,
): string {
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byRule.get(v.ruleName) ?? [];
    list.push(v);
    byRule.set(v.ruleName, list);
  }

  const out: string[] = [];
  out.push(`PolyGraph check · ${opts.root} · ${opts.fileCount} files`);
  if (opts.baseline) out.push(`baseline: ${opts.baseline} (reporting new violations only)`);
  out.push("");

  const renderRule = (name: string) => {
    const hits = byRule.get(name) ?? [];
    if (hits.length === 0) {
      out.push(`${CHECK} ${name}`);
      return;
    }
    const sev = hits[0].severity;
    const marker = sev === "error" ? CROSS : WARN;
    out.push(
      `${marker} ${name} (${sev}) — ${hits.length} violation${hits.length === 1 ? "" : "s"}`,
    );
    for (const v of hits.slice(0, 10)) out.push(`    ${shortLine(v)}`);
    if (hits.length > 10) out.push(`    … and ${hits.length - 10} more`);
  };

  for (const rule of config.rules) renderRule(rule.name);

  const { thresholds } = config;
  if (thresholds.maxFanOut !== undefined) renderRule("maxFanOut");
  if (thresholds.maxDependencyDepth !== undefined) renderRule("maxDependencyDepth");

  out.push("");
  const { errors, warnings } = countBySeverity(violations);
  if (errors === 0 && warnings === 0) {
    out.push(`${CHECK} No violations.`);
  } else {
    out.push(
      `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
    );
  }
  return `${out.join("\n")}\n`;
}

function pctPhrase(pct: number | null, before: number, after: number): string {
  if (pct === null) return `gained dependents (0 → ${after})`;
  const dir = pct >= 0 ? "increased" : "decreased";
  return `blast radius ${dir} by ${Math.abs(Math.round(pct))}% (${before} → ${after})`;
}

/** Render a graph diff in the compact "Current branch ↔ main" style. */
export function formatDiff(diff: GraphDiff): string {
  const headLabel = diff.head === "working tree" ? "Current branch" : diff.head;
  const out: string[] = [];
  out.push(`${headLabel} ↔ ${diff.base}`);
  out.push("");

  const s = diff.summary;
  out.push(`+ ${s.nodesAdded} nodes`);
  out.push(`- ${s.nodesRemoved} nodes`);
  if (s.nodesChanged > 0) out.push(`~ ${s.nodesChanged} changed nodes`);
  out.push(`+ ${s.edgesAdded} relationships`);
  out.push(`- ${s.edgesRemoved} relationships`);

  if (s.newCycles > 0) out.push(`${WARN} ${s.newCycles} new cycle${s.newCycles === 1 ? "" : "s"}`);
  if (s.removedCycles > 0) {
    out.push(`${CHECK} ${s.removedCycles} cycle${s.removedCycles === 1 ? "" : "s"} resolved`);
  }

  // Headline blast-radius movements (meaningful changes only).
  const notable = diff.blastRadiusDeltas
    .filter((d) => d.pctChange === null || Math.abs(d.pctChange) >= 10)
    .slice(0, 5);
  for (const d of notable) {
    const marker = d.delta > 0 ? WARN : CHECK;
    out.push(`${marker} ${d.label} ${pctPhrase(d.pctChange, d.before, d.after)}`);
  }

  if (
    s.nodesAdded === 0 &&
    s.nodesRemoved === 0 &&
    s.nodesChanged === 0 &&
    s.edgesAdded === 0 &&
    s.edgesRemoved === 0
  ) {
    out.push("");
    out.push("No structural changes.");
  }

  return `${out.join("\n")}\n`;
}
