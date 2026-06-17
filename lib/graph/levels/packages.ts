// Project the base symbol graph up to the Package and Workspace levels.
//
// Each base node is assigned to the package that owns its file (the nearest enclosing
// manifest directory); nodes outside any manifest fall into a synthetic «root» package,
// and external nodes become one package each so dependency arrows survive the projection.
// Cross-package base edges are aggregated into package→package edges, then unioned with
// the dependencies the manifests declare.

import {
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  edgeId,
  makeEdge,
  mergeEvidence,
} from "../types";
import type { PackageManifest } from "./types";

export const ROOT_PACKAGE_ID = "pkg:«root»";
const DEFAULT_WORKSPACE = "«workspace»";

const packageNodeId = (manifestId: string) => `pkg:${manifestId}`;
const externalPackageNodeId = (label: string) => `pkg:ext:${label}`;

/** Does `dir` (normalized, no trailing slash) contain `filePath`? "" contains everything. */
function dirContains(dir: string, filePath: string): boolean {
  if (dir === "") return true;
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

/** Manifests sorted so the deepest (most specific) directory wins a nearest-enclosing match. */
function byDepthDesc(manifests: PackageManifest[]): PackageManifest[] {
  return [...manifests].sort((a, b) => b.dir.length - a.dir.length);
}

/** The manifest whose directory most tightly encloses `filePath`, or null. */
function nearestManifest(filePath: string, sorted: PackageManifest[]): PackageManifest | null {
  for (const m of sorted) if (dirContains(m.dir, filePath)) return m;
  return null;
}

export interface PackageAssignment {
  /** base node id → package node id */
  packageOf: Map<string, string>;
  /** package node id → its display node */
  packageNodes: Map<string, GraphNode>;
  /** package node id → owning manifest (internal packages only) */
  manifestOf: Map<string, PackageManifest>;
}

function internalPackageNode(m: PackageManifest): GraphNode {
  const id = packageNodeId(m.id);
  return {
    id,
    kind: "module",
    label: m.name,
    filePath: m.dir || "/",
    line: 0,
    parentFile: id,
  };
}

function rootPackageNode(): GraphNode {
  return {
    id: ROOT_PACKAGE_ID,
    kind: "module",
    label: "«root»",
    filePath: "/",
    line: 0,
    parentFile: ROOT_PACKAGE_ID,
  };
}

function externalPackageNode(n: GraphNode): GraphNode {
  const id = externalPackageNodeId(n.label);
  return {
    id,
    kind: "external",
    label: n.label,
    filePath: "",
    line: 0,
    parentFile: id,
    externalKind: n.externalKind,
    dependencyType: n.dependencyType,
    version: n.version,
  };
}

/** Assign every base node to a package node, materialising the package nodes on demand. */
export function assignPackages(graph: GraphModel, manifests: PackageManifest[]): PackageAssignment {
  const sorted = byDepthDesc(manifests);
  const packageOf = new Map<string, string>();
  const packageNodes = new Map<string, GraphNode>();
  const manifestOf = new Map<string, PackageManifest>();

  for (const n of graph.nodes) {
    if (n.kind === "external") {
      const id = externalPackageNodeId(n.label);
      if (!packageNodes.has(id)) packageNodes.set(id, externalPackageNode(n));
      packageOf.set(n.id, id);
      continue;
    }
    const m = nearestManifest(n.filePath, sorted);
    if (m) {
      const id = packageNodeId(m.id);
      if (!packageNodes.has(id)) {
        packageNodes.set(id, internalPackageNode(m));
        manifestOf.set(id, m);
      }
      packageOf.set(n.id, id);
    } else {
      if (!packageNodes.has(ROOT_PACKAGE_ID)) packageNodes.set(ROOT_PACKAGE_ID, rootPackageNode());
      packageOf.set(n.id, ROOT_PACKAGE_ID);
    }
  }

  return { packageOf, packageNodes, manifestOf };
}

/** Aggregate base edges into group→group edges via `groupOf` (drops self/unknown). */
function aggregateEdges(
  baseEdges: GraphEdge[],
  groupOf: (id: string) => string | undefined,
): Map<string, GraphEdge> {
  const byId = new Map<string, GraphEdge>();
  for (const e of baseEdges) {
    const s = groupOf(e.source);
    const t = groupOf(e.target);
    if (!s || !t || s === t) continue;
    const id = edgeId(s, t, "import");
    let agg = byId.get(id);
    if (!agg) {
      agg = makeEdge(s, t, "import");
      byId.set(id, agg);
    }
    mergeEvidence(agg, e);
  }
  return byId;
}

/** Project the base graph to the Package level. */
export function projectToPackages(graph: GraphModel, manifests: PackageManifest[]): GraphModel {
  const { packageOf, packageNodes, manifestOf } = assignPackages(graph, manifests);
  const edges = aggregateEdges(graph.edges, (id) => packageOf.get(id));

  // Union declared manifest deps: an edge from each internal package to any other
  // package (internal by name, or external) that it declares as a dependency.
  const internalByName = new Map<string, string>();
  for (const [pkgId, m] of manifestOf) internalByName.set(m.name, pkgId);

  for (const [pkgId, m] of manifestOf) {
    for (const dep of m.declaredDeps) {
      const target =
        internalByName.get(dep.name) ??
        (packageNodes.has(externalPackageNodeId(dep.name))
          ? externalPackageNodeId(dep.name)
          : undefined);
      if (!target || target === pkgId) continue;
      const id = edgeId(pkgId, target, "import");
      if (!edges.has(id)) edges.set(id, makeEdge(pkgId, target, "import"));
    }
  }

  return { nodes: [...packageNodes.values()], edges: [...edges.values()] };
}

/** Project the base graph to the Workspace level (packages grouped by their workspace). */
export function projectToWorkspaces(graph: GraphModel, manifests: PackageManifest[]): GraphModel {
  const sorted = byDepthDesc(manifests);
  const groupOf = new Map<string, string>();
  const groupNodes = new Map<string, GraphNode>();

  for (const n of graph.nodes) {
    if (n.kind === "external") {
      const id = externalPackageNodeId(n.label);
      if (!groupNodes.has(id)) groupNodes.set(id, externalPackageNode(n));
      groupOf.set(n.id, id);
      continue;
    }
    const m = nearestManifest(n.filePath, sorted);
    const ws = m?.workspace ?? DEFAULT_WORKSPACE;
    const id = `ws:${ws}`;
    if (!groupNodes.has(id)) {
      groupNodes.set(id, {
        id,
        kind: "namespace",
        label: ws,
        filePath: "/",
        line: 0,
        parentFile: id,
      });
    }
    groupOf.set(n.id, id);
  }

  const edges = aggregateEdges(graph.edges, (id) => groupOf.get(id));
  return { nodes: [...groupNodes.values()], edges: [...edges.values()] };
}

/** Package name for a base node id (for the `package:` query field). */
export function packageNameResolver(
  graph: GraphModel,
  manifests: PackageManifest[],
): (node: GraphNode) => string | undefined {
  const { packageOf, packageNodes } = assignPackages(graph, manifests);
  return (node) => {
    const pkgId = packageOf.get(node.id);
    return pkgId ? packageNodes.get(pkgId)?.label : undefined;
  };
}
