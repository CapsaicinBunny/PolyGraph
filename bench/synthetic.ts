// Deterministic synthetic graphs for scale benchmarks. Produces a GraphModel of
// `fileCount` file nodes spread across directories with import edges — enough to
// exercise layout + the LOD pipeline (hierarchy, adaptive cut, auto-collapse) at
// sizes the real fixtures don't reach. No source files / no scanning involved.

import { type GraphEdge, type GraphModel, type GraphNode, makeEdge } from "../lib/graph/types";

export function makeSyntheticGraph(fileCount: number): GraphModel {
  const dirCount = Math.max(1, Math.round(Math.sqrt(fileCount)));
  const nodes: GraphNode[] = [];
  for (let i = 0; i < fileCount; i++) {
    const d = i % dirCount;
    const id = `src/d${d}/f${i}.ts`;
    nodes.push({ id, kind: "file", label: `f${i}.ts`, filePath: id, line: 0, parentFile: id });
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < fileCount; i++) {
    const a = nodes[i].id;
    // Ring dependency + a periodic cross-directory edge → a connected, cyclic graph.
    const next = nodes[(i + 1) % fileCount].id;
    if (a !== next) edges.push(makeEdge(a, next, "import"));
    if (i % 7 === 0) {
      const cross = nodes[(i + dirCount) % fileCount].id;
      if (a !== cross) edges.push(makeEdge(a, cross, "import"));
    }
  }
  return { nodes, edges };
}

// ── Shaped fixtures for the representation-LOD benchmark (spec Appendix A §L) ──
// "dense" (high edge/node), "deep" (many rep levels), "wide" (thousands of sibling
// groups). All deterministic; file nodes only (the LOD pipeline groups by directory).

/** node id → file node, in a directory `dir`. */
function fileNode(dir: string, name: string): GraphNode {
  const id = dir ? `${dir}/${name}` : name;
  return { id, kind: "file", label: name, filePath: id, line: 0, parentFile: id };
}

/**
 * DENSE: a high edge-to-node ratio (each node links to `degree` others) over a modest
 * directory spread — stresses edge remap + aggregation and the proxy-internal density path.
 */
export function makeDenseGraph(fileCount: number, degree = 16): GraphModel {
  const dirCount = Math.max(1, Math.round(Math.sqrt(fileCount)));
  const nodes: GraphNode[] = [];
  for (let i = 0; i < fileCount; i++) nodes.push(fileNode(`src/d${i % dirCount}`, `f${i}.ts`));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < fileCount; i++) {
    for (let k = 1; k <= degree; k++) {
      const j = (i + k * 2654435761) % fileCount; // Knuth-hash spread of targets
      if (i !== j) edges.push(makeEdge(nodes[i].id, nodes[j].id, "import"));
    }
  }
  return { nodes, edges };
}

/**
 * DEEP: a narrow but very deep directory tree (`depth` nested levels), so the
 * representation hierarchy has many proxy LEVELS — stresses the antichain walk / DFS
 * intervals / refinement depth. `fileCount` files distributed down the chain.
 */
export function makeDeepGraph(fileCount: number, depth = 40): GraphModel {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < fileCount; i++) {
    // Build a path a/a/a/… of length (i % depth)+1 so files land at every level.
    const levels = (i % depth) + 1;
    const dir = Array.from({ length: levels }, (_, d) => `L${d}`).join("/");
    nodes.push(fileNode(dir, `f${i}.ts`));
  }
  const edges: GraphEdge[] = [];
  for (let i = 0; i < fileCount; i++) {
    const next = nodes[(i + 1) % fileCount].id;
    if (nodes[i].id !== next) edges.push(makeEdge(nodes[i].id, next, "import"));
  }
  return { nodes, edges };
}

/**
 * WIDE: thousands of sibling top-level groups, each with a few files — stresses the
 * root-level fan-out (many sibling proxies, the cut's per-root scan). `groupCount` sibling
 * dirs, `perGroup` files each.
 */
export function makeWideGraph(groupCount: number, perGroup = 4): GraphModel {
  const nodes: GraphNode[] = [];
  for (let g = 0; g < groupCount; g++) {
    for (let f = 0; f < perGroup; f++) nodes.push(fileNode(`src/g${g}`, `f${f}.ts`));
  }
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const next = nodes[(i + 1) % nodes.length].id;
    if (nodes[i].id !== next) edges.push(makeEdge(nodes[i].id, next, "import"));
  }
  return { nodes, edges };
}
