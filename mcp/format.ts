// Small pure helpers shared by the operations and the server's text summaries.

import type { EdgeConfidence, GraphEdge, GraphNode } from "../lib/graph/types";

/** Count occurrences of each value into a plain record — a compact histogram. */
export function histogram(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** The minimal node shape returned in list results (query, diff). */
export interface BriefNode {
  id: string;
  kind: string;
  label: string;
  filePath: string;
  line: number;
}

export function briefNode(n: GraphNode): BriefNode {
  return { id: n.id, kind: n.kind, label: n.label, filePath: n.filePath, line: n.line };
}

/**
 * One representative confidence for an edge that has several occurrences: `exact`
 * if any occurrence resolved exactly, else `ambiguous` if any was ambiguous, else
 * `inferred`. (A relationship pinned exactly even once is known exactly.)
 */
export function edgeConfidence(e: GraphEdge): EdgeConfidence {
  let sawAmbiguous = false;
  for (const o of e.occurrences) {
    if (o.confidence === "exact") return "exact";
    if (o.confidence === "ambiguous") sawAmbiguous = true;
  }
  return sawAmbiguous ? "ambiguous" : "inferred";
}

/** Render a histogram as "file×120, function×88, …" sorted desc, capped. */
export function histText(h: Record<string, number>, cap = 8): string {
  const entries = Object.entries(h).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, cap).map(([k, v]) => `${k}×${v}`);
  if (entries.length > cap) shown.push(`+${entries.length - cap} more`);
  return shown.join(", ") || "none";
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
