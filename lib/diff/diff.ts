// Compare two GraphModels (e.g. a feature branch vs. main) into a structured
// GraphDiff: which nodes/edges were added, removed, or changed; which cycles are
// new; and how much each affected node's blast radius moved. Pure and
// deterministic. The UI consumes this to render added/removed/changed overlays;
// the CLI renders the summary as text.

import { blastRadius } from "../graph/query";
import type { GraphEdge, GraphModel, GraphNode } from "../graph/types";
import { stronglyConnectedComponents } from "../layout/scc";

export type ChangeStatus = "added" | "removed" | "changed" | "unchanged";

/** A node present in both graphs whose attributes differ. */
export interface NodeChange {
  id: string;
  before: GraphNode;
  after: GraphNode;
  /** Attribute names that differ (kind, label, role, environment, category). */
  fields: string[];
}

export interface CycleInfo {
  /** Canonical id `scc:<sorted members>` — stable across runs. */
  id: string;
  members: string[];
  labels: string[];
}

/** How a node's blast radius (transitive dependents) moved between graphs. */
export interface BlastDelta {
  id: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  /** Percent change vs. `before`; null when `before` was 0 (undefined ratio). */
  pctChange: number | null;
}

export interface DiffSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  newCycles: number;
  removedCycles: number;
}

export interface GraphDiff {
  base: string;
  head: string;
  nodes: {
    added: GraphNode[];
    removed: GraphNode[];
    changed: NodeChange[];
    unchangedCount: number;
  };
  edges: {
    added: GraphEdge[];
    removed: GraphEdge[];
    unchangedCount: number;
  };
  newCycles: CycleInfo[];
  removedCycles: CycleInfo[];
  blastRadiusDeltas: BlastDelta[];
  summary: DiffSummary;
}

const COMPARED_FIELDS = ["kind", "label", "role", "environment", "category"] as const;

function changedFields(a: GraphNode, b: GraphNode): string[] {
  return COMPARED_FIELDS.filter((f) => a[f] !== b[f]);
}

/** Cycles (SCCs with >1 member) keyed by canonical id, with display labels. */
function cyclesOf(graph: GraphModel): Map<string, CycleInfo> {
  const labelById = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const result = new Map<string, CycleInfo>();
  for (const scc of stronglyConnectedComponents(
    graph.nodes.map((n) => n.id),
    graph.edges.map((e) => ({ source: e.source, target: e.target })),
  )) {
    if (scc.members.length < 2) continue;
    result.set(scc.id, {
      id: scc.id,
      members: scc.members,
      labels: scc.members.map((m) => labelById.get(m) ?? m),
    });
  }
  return result;
}

/** Blast-radius deltas for the nodes most directly affected by edge changes. */
function blastDeltas(
  before: GraphModel,
  after: GraphModel,
  addedEdges: GraphEdge[],
  removedEdges: GraphEdge[],
  cap: number,
): BlastDelta[] {
  const beforeIds = new Set(before.nodes.map((n) => n.id));
  const afterIds = new Set(after.nodes.map((n) => n.id));
  const labelAfter = new Map(after.nodes.map((n) => [n.id, n.label]));

  // Candidates: endpoints of changed edges that exist in *both* graphs (so a
  // before/after comparison is meaningful). Bounds the cost of the reverse-BFS.
  const candidates = new Set<string>();
  for (const e of [...addedEdges, ...removedEdges]) {
    for (const id of [e.source, e.target]) {
      if (beforeIds.has(id) && afterIds.has(id)) candidates.add(id);
    }
  }

  const deltas: BlastDelta[] = [];
  for (const id of candidates) {
    const b = blastRadius(before, id).total;
    const a = blastRadius(after, id).total;
    if (a === b) continue;
    deltas.push({
      id,
      label: labelAfter.get(id) ?? id,
      before: b,
      after: a,
      delta: a - b,
      pctChange: b > 0 ? ((a - b) / b) * 100 : null,
    });
  }
  // Largest movements first; ties broken by id for determinism.
  deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.id < y.id ? -1 : 1));
  return deltas.slice(0, cap);
}

export interface DiffOptions {
  /** Max blast-radius deltas to report (default 20). */
  blastRadiusCap?: number;
}

/** Diff two graphs. `before`/`after` are usually base (e.g. main) and head. */
export function diffGraphs(
  before: GraphModel,
  after: GraphModel,
  base = "base",
  head = "head",
  options: DiffOptions = {},
): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes: GraphNode[] = [];
  const changed: NodeChange[] = [];
  let unchangedNodes = 0;
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      addedNodes.push(node);
    } else {
      const fields = changedFields(prev, node);
      if (fields.length > 0) changed.push({ id: node.id, before: prev, after: node, fields });
      else unchangedNodes++;
    }
  }
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(e.id));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(e.id));
  const unchangedEdges = after.edges.length - addedEdges.length;

  const beforeCycles = cyclesOf(before);
  const afterCycles = cyclesOf(after);
  const newCycles = [...afterCycles.values()].filter((c) => !beforeCycles.has(c.id));
  const removedCycles = [...beforeCycles.values()].filter((c) => !afterCycles.has(c.id));

  const blastRadiusDeltas = blastDeltas(
    before,
    after,
    addedEdges,
    removedEdges,
    options.blastRadiusCap ?? 20,
  );

  return {
    base,
    head,
    nodes: { added: addedNodes, removed: removedNodes, changed, unchangedCount: unchangedNodes },
    edges: { added: addedEdges, removed: removedEdges, unchangedCount: unchangedEdges },
    newCycles,
    removedCycles,
    blastRadiusDeltas,
    summary: {
      nodesAdded: addedNodes.length,
      nodesRemoved: removedNodes.length,
      nodesChanged: changed.length,
      edgesAdded: addedEdges.length,
      edgesRemoved: removedEdges.length,
      newCycles: newCycles.length,
      removedCycles: removedCycles.length,
    },
  };
}

/**
 * Per-id status lookup for renderers. Added/removed/changed come straight from
 * the diff; anything else present in either graph is "unchanged".
 */
export function buildStatusMap(diff: GraphDiff): Map<string, ChangeStatus> {
  const status = new Map<string, ChangeStatus>();
  for (const n of diff.nodes.added) status.set(n.id, "added");
  for (const n of diff.nodes.removed) status.set(n.id, "removed");
  for (const c of diff.nodes.changed) status.set(c.id, "changed");
  return status;
}
