// Plain-text renderers for the CLI. Kept free of ANSI color so output is clean
// in CI logs; structured outputs (SARIF, JSON) are produced elsewhere.

import type { PolygraphConfig } from "../config/schema";
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
