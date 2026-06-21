import { describe, expect, test } from "bun:test";
import { buildClusterTreeFromSnapshot } from "../layout/clusters";
import { type DimensionCatalog, mergeDescriptors, STRUCTURAL_DESCRIPTORS } from "./dimensions";
import type { FacetKey } from "./dimensions";
import type { FacetSelection } from "./facet-selection";
import { NO_GROUP } from "./grouping-snapshot";
import type { PackageManifest } from "./levels/types";
import { buildSceneStructure, type SceneFilters } from "./scene";
import { FILTERABLE_EDGE_KINDS } from "./visual";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const withFacet = (path: string, facets: Record<string, string[]>) => ({ ...file(path), facets });

function filters(folders: string[], langs: string[]): SceneFilters {
  return {
    showExternal: false,
    enabledFacets: new Map<FacetKey, FacetSelection>(),
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    enabledFolders: new Set(folders),
    enabledLanguages: new Set(langs),
  };
}

describe("scene grouping snapshot — per mode (Phase C1a)", () => {
  test("directory mode emits a snapshot whose cluster tree has the directory box ids", () => {
    const graph: GraphModel = {
      nodes: [file("src/a.ts"), file("src/b.ts"), file("lib/c.ts")],
      edges: [],
    };
    const s = buildSceneStructure(
      graph,
      new Set(),
      filters(["src", "lib", "/"], ["TS"]),
      "smart",
      "LR",
      new Set(),
      "directory",
    );
    const snap = s.options.groupingSnapshot!;
    expect(snap).toBeTruthy();
    expect(snap.modeKey).toBe("directory");
    // The cluster tree rebuilt from the snapshot carries the directory boxes.
    const { root } = buildClusterTreeFromSnapshot(s.layoutInput.nodes, snap);
    const boxIds = [...root.children.values()].map((c) => c.id).sort();
    expect(boxIds).toEqual(["lib", "src"]);
  });

  test("facet mode emits a flat snapshot keyed by facet:<key>:<value>", () => {
    // Build a catalog where env is groupable single-cardinality.
    const envSchema = [
      {
        key: "env",
        label: "Environment",
        dimension: "facet" as const,
        cardinality: "single" as const,
        domain: "closed" as const,
        values: [
          { value: "client", label: "Client" },
          { value: "server", label: "Server" },
        ],
        providerIds: ["core"],
        filterable: true,
        groupable: true,
        grouping: { mode: "single" as const },
        missing: { filter: "include" as const, group: "unclassified" as const },
      },
    ];
    const catalog: DimensionCatalog = mergeDescriptors([STRUCTURAL_DESCRIPTORS, envSchema]).catalog;
    const graph: GraphModel = {
      nodes: [
        withFacet("a.ts", { env: ["client"] }),
        withFacet("b.ts", { env: ["client"] }),
        withFacet("c.ts", { env: ["server"] }),
        file("d.ts"), // no env → unclassified (NO_GROUP)
      ],
      edges: [],
    };
    const s = buildSceneStructure(
      graph,
      new Set(),
      filters(["/"], ["TS"]),
      "smart",
      "LR",
      new Set(),
      "facet:env",
      1,
      false,
      null,
      null,
      false,
      catalog,
    );
    const snap = s.options.groupingSnapshot!;
    expect(snap.modeKey).toBe("facet:env");
    expect([...snap.groupIds].sort()).toEqual(["facet:env:client", "facet:env:server"]);
    expect([...snap.boxKeyByGroup].sort()).toEqual(["facet:env:client", "facet:env:server"]);
    // The unclassified node (d.ts) is NO_GROUP; classified nodes are grouped.
    const ids = s.layoutInput.nodes.map((n) => n.id);
    expect(snap.directGroupByNode[ids.indexOf("d.ts")]).toBe(NO_GROUP);
    expect(snap.directGroupByNode[ids.indexOf("a.ts")]).not.toBe(NO_GROUP);
    // The cluster tree rebuilds flat facet boxes.
    const { root } = buildClusterTreeFromSnapshot(s.layoutInput.nodes, snap);
    expect([...root.children.values()].map((c) => c.id).sort()).toEqual([
      "facet:env:client",
      "facet:env:server",
    ]);
  });

  test("package mode emits a flat snapshot keyed by the package node id", () => {
    const graph: GraphModel = {
      nodes: [file("apps/web/a.ts"), file("apps/web/b.ts"), file("libs/core/c.ts")],
      edges: [],
    };
    const manifests: PackageManifest[] = [
      {
        id: "npm:web",
        name: "web",
        ecosystem: "npm",
        dir: "apps/web",
        manifestPath: "apps/web/package.json",
        declaredDeps: [],
      },
      {
        id: "npm:core",
        name: "core",
        ecosystem: "npm",
        dir: "libs/core",
        manifestPath: "libs/core/package.json",
        declaredDeps: [],
      },
    ];
    const s = buildSceneStructure(
      graph,
      new Set(),
      filters(["apps", "libs", "/"], ["TS"]),
      "smart",
      "LR",
      new Set(),
      "package",
      1,
      false,
      null,
      null,
      false,
      undefined,
      manifests,
    );
    const snap = s.options.groupingSnapshot!;
    expect(snap.modeKey).toBe("package");
    expect([...snap.groupIds].sort()).toEqual(["package:pkg:npm:core", "package:pkg:npm:web"]);
    expect([...snap.boxKeyByGroup].sort()).toEqual(["pkg:npm:core", "pkg:npm:web"]);
    const { root } = buildClusterTreeFromSnapshot(s.layoutInput.nodes, snap);
    expect([...root.children.values()].map((c) => c.id).sort()).toEqual([
      "pkg:npm:core",
      "pkg:npm:web",
    ]);
  });

  test("none mode emits no snapshot (boxless layout)", () => {
    const graph: GraphModel = { nodes: [file("a/x.ts")], edges: [] };
    const s = buildSceneStructure(
      graph,
      new Set(),
      filters(["a", "/"], ["TS"]),
      "smart",
      "LR",
      new Set(),
      "none",
    );
    expect(s.options.groupingSnapshot).toBeUndefined();
  });
});
