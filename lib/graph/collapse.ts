import { EXTERNAL_DIR } from "../layout/clusters";
import { edgeId, type GraphModel, type GraphNode } from "./types";

/** Aggregate-node id encoding. The `#` makes the directory logic in clusters.ts
 * resolve the aggregate to the PARENT of the collapsed dir, so the card lands in
 * the right enclosing cluster and the collapsed dir itself draws no box. */
export const AGG_SUFFIX = "#__agg__";
export const aggregateNodeId = (clusterId: string): string => clusterId + AGG_SUFFIX;
export const isAggregateId = (id: string): boolean => id.endsWith(AGG_SUFFIX);
export const clusterIdOfAggregate = (id: string): string => id.slice(0, -AGG_SUFFIX.length);

/**
 * Directory prefixes of a node, outermost-first: `"a/b/c.ts#x"` → `["a", "a/b"]`.
 * External nodes group under the synthetic `«external»` cluster (mirrors clusters.ts).
 */
function dirPrefixes(node: { id: string; kind: string }): string[] {
  if (node.kind === "external") return [EXTERNAL_DIR];
  const hash = node.id.indexOf("#");
  const filePath = hash === -1 ? node.id : node.id.slice(0, hash);
  const parts = filePath.split("/");
  parts.pop(); // drop the filename
  const out: string[] = [];
  let path = "";
  for (const seg of parts) {
    if (!seg) continue;
    path = path ? `${path}/${seg}` : seg;
    out.push(path);
  }
  return out;
}

const lastSegment = (clusterId: string): string => clusterId.slice(clusterId.lastIndexOf("/") + 1);

/**
 * Collapse the given directory clusters: every node under a collapsed cluster is
 * replaced by a single aggregate node for that cluster, and edges touching absorbed
 * nodes are rerouted to the aggregate (self-loops dropped, duplicates merged). Pure —
 * returns a new GraphModel, or the input unchanged when nothing collapses.
 */
export function collapseClusters(
  graph: GraphModel,
  collapsed: Set<string>,
  communityOf?: Map<string, string>,
): GraphModel {
  if (collapsed.size === 0) return graph;

  // Each node → its outermost collapsed ancestor dir (the collapse root), if any.
  const absorbedBy = new Map<string, string>();
  for (const n of graph.nodes) {
    let absorbed = false;
    for (const prefix of dirPrefixes(n)) {
      if (collapsed.has(prefix)) {
        absorbedBy.set(n.id, prefix);
        absorbed = true;
        break; // outermost-first
      }
    }
    // Fall back to community membership when no directory absorbed the node.
    if (!absorbed && communityOf) {
      const community = communityOf.get(n.id);
      if (community && collapsed.has(community)) absorbedBy.set(n.id, community);
    }
  }
  if (absorbedBy.size === 0) return graph;

  // Count absorbed *file* nodes per cluster for the badge.
  const fileCounts = new Map<string, number>();
  for (const [nodeId, cid] of absorbedBy) {
    if (!nodeId.includes("#")) fileCounts.set(cid, (fileCounts.get(cid) ?? 0) + 1);
  }

  const nodes: GraphNode[] = graph.nodes.filter((n) => !absorbedBy.has(n.id));
  // One aggregate node per cluster that actually absorbed something.
  const aggClusters = [...new Set(absorbedBy.values())].sort();
  for (const cid of aggClusters) {
    const count = fileCounts.get(cid) ?? 0;
    const id = aggregateNodeId(cid);
    nodes.push({
      id,
      kind: "file",
      label: `${lastSegment(cid)} · ${count}`,
      filePath: cid,
      line: 0,
      parentFile: id,
    });
  }

  const remap = (nodeId: string): string => {
    const cid = absorbedBy.get(nodeId);
    return cid ? aggregateNodeId(cid) : nodeId;
  };
  const seen = new Set<string>();
  const edges = [];
  for (const e of graph.edges) {
    const source = remap(e.source);
    const target = remap(e.target);
    if (source === target) continue; // self-loop after collapse
    const key = edgeId(source, target, e.kind);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: key, source, target, kind: e.kind });
  }

  return { nodes, edges };
}
