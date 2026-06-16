import { buildView, type ViewEdgeKind } from "../aggregate";
import {
  type LayoutAlgorithm,
  type LayoutDirection,
  layoutViewCached,
  nodeSize,
  type XYPosition,
} from "../layout";
import type {
  Environment,
  ExternalKind,
  GraphModel,
  NodeCategory,
  NodeKind,
  NodeRole,
  Runtime,
} from "./types";
import { EDGE_STYLES, nodeStyle } from "./visual";

export interface SceneFilters {
  showExternal: boolean;
  enabledNodeKinds: Set<NodeKind>;
  enabledCategories: Set<NodeCategory>;
  enabledEnvironments: Set<Environment>;
  enabledRuntimes: Set<Runtime>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
}

export interface SceneNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: NodeKind;
  role?: NodeRole;
  externalKind?: ExternalKind;
  label: string;
  /** Accent color (border / glyph), from role/external/kind. */
  color: string;
  symbolCount: number;
  isFile: boolean;
  isExternal: boolean;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  kind: ViewEdgeKind;
  color: string;
  dashed: boolean;
  toExternal: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  positions: Map<string, XYPosition>;
}

let graphCounter = 0;
const graphIds = new WeakMap<object, string>();

/** Stable per-analysis id so the layout cache signature can't collide across scans. */
export function graphKeyFor(graph: GraphModel): string {
  let id = graphIds.get(graph);
  if (!id) {
    graphCounter += 1;
    id = String(graphCounter);
    graphIds.set(graph, id);
  }
  return id;
}

function ser<T>(set: Set<T>): string {
  return [...set].map(String).sort().join(",");
}

/**
 * Build a positioned, styled scene from the graph + filters + layout. Pure and shared
 * by both the React Flow and the Pixi (GPU) renderers. Layout is cached.
 */
export function buildScene(
  graph: GraphModel,
  expanded: Set<string>,
  filters: SceneFilters,
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection,
): Scene {
  const {
    showExternal,
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
    enabledEdgeKinds,
  } = filters;

  const visible = (n: GraphModel["nodes"][number]) => {
    if (n.kind === "external") return showExternal;
    if (n.environment && !enabledEnvironments.has(n.environment)) return false;
    if (n.runtimes?.length && !n.runtimes.some((r) => enabledRuntimes.has(r))) return false;
    if (n.kind === "file") return true;
    return enabledNodeKinds.has(n.kind) && (!n.category || enabledCategories.has(n.category));
  };
  const keptIds = new Set(graph.nodes.filter(visible).map((n) => n.id));
  const sourceGraph = {
    nodes: graph.nodes.filter(visible),
    edges: graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
  };
  const view = buildView(sourceGraph, expanded);
  const visibleEdges = view.edges.filter(
    (e) => e.kind === "contains" || enabledEdgeKinds.has(e.kind),
  );

  const signature = [
    graphKeyFor(graph),
    algorithm,
    direction,
    `x${showExternal ? 1 : 0}`,
    ser(expanded),
    ser(enabledNodeKinds),
    ser(enabledCategories),
    ser(enabledEnvironments),
    ser(enabledRuntimes),
    ser(enabledEdgeKinds),
  ].join("|");
  const positions = layoutViewCached(
    signature,
    { nodes: view.nodes, edges: visibleEdges },
    {
      algorithm,
      direction,
    },
  );

  const symbolCount = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") symbolCount.set(n.parentFile, (symbolCount.get(n.parentFile) ?? 0) + 1);
  }

  const externalColor = new Map<string, string>();
  for (const n of view.nodes) {
    if (n.kind === "external")
      externalColor.set(n.id, nodeStyle(n.kind, n.role, n.externalKind).color);
  }

  const nodes: SceneNode[] = view.nodes.map((n) => {
    const size = nodeSize(n.kind);
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
      kind: n.kind,
      role: n.role,
      externalKind: n.externalKind,
      label: n.label,
      color: nodeStyle(n.kind, n.role, n.externalKind).color,
      symbolCount: symbolCount.get(n.id) ?? 0,
      isFile: n.kind === "file",
      isExternal: n.kind === "external",
    };
  });

  const edges: SceneEdge[] = visibleEdges.map((e) => {
    const toExternal = externalColor.get(e.target);
    const color = toExternal ?? EDGE_STYLES[e.kind].color;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
      color,
      dashed: e.kind === "contains",
      toExternal: toExternal !== undefined,
    };
  });

  return { nodes, edges, positions };
}
