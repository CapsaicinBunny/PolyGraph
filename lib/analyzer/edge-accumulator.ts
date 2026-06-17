// Accumulates edge evidence across many `add` calls, keyed by (source, target,
// kind). Caps retained occurrences at OCCURRENCE_CAP while keeping an exact total
// `count`, dedupes identical occurrences, and drops self-edges.

import {
  type EdgeEvidence,
  type EdgeKind,
  edgeId,
  type GraphEdge,
  OCCURRENCE_CAP,
} from "../graph/types";

function evidenceKey(ev: EdgeEvidence): string {
  return `${ev.filePath}:${ev.line}:${ev.column ?? ""}`;
}

interface Accum {
  edge: GraphEdge;
  seen: Set<string>;
}

export class EdgeBuilder {
  private readonly edges = new Map<string, Accum>();

  add(source: string, target: string, kind: EdgeKind, evidence: EdgeEvidence): void {
    if (source === target) return;

    const id = edgeId(source, target, kind);
    const existing = this.edges.get(id);
    if (!existing) {
      this.edges.set(id, {
        edge: { id, source, target, kind, occurrences: [evidence], count: 1 },
        seen: new Set([evidenceKey(evidence)]),
      });
      return;
    }

    const key = evidenceKey(evidence);
    if (existing.seen.has(key)) return; // identical syntactic site — skip entirely
    existing.seen.add(key);

    existing.edge.count += 1;
    if (existing.edge.occurrences.length < OCCURRENCE_CAP) {
      existing.edge.occurrences.push(evidence);
    }
  }

  build(): GraphEdge[] {
    return [...this.edges.values()].map((a) => a.edge);
  }
}
