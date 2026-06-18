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
