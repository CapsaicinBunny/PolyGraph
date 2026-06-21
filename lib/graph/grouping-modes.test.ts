import { describe, expect, test } from "bun:test";
import {
  communityGrouping,
  facetGrouping,
  type GroupingHierarchy,
  packageGrouping,
  syntheticNoneGrouping,
} from "./grouping";
import { buildGroupingSnapshot, groupPath, NO_GROUP } from "./grouping-snapshot";
import type { DimensionDescriptor } from "./dimensions";
import type { PackageManifest } from "./levels/types";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const E = (source: string, target: string) => makeEdge(source, target, "import");
const sorted = (ids: string[]) => [...ids].sort();

// ── Package grouping ────────────────────────────────────────────────────────
describe("packageGrouping — flat, one group per package, namespaced", () => {
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
  const h = packageGrouping(graph, manifests);

  test("ids are namespaced 'package:' and are the package node ids", () => {
    expect(sorted(h.roots())).toEqual(["package:pkg:npm:core", "package:pkg:npm:web"]);
  });

  test("a flat hierarchy: every group is a root with no children", () => {
    for (const r of h.roots()) expect(h.childrenOf(r)).toEqual([]);
  });

  test("groupOfNode maps a node to its owning package", () => {
    expect(h.groupOfNode("apps/web/a.ts")).toBe("package:pkg:npm:web");
    expect(h.groupOfNode("libs/core/c.ts")).toBe("package:pkg:npm:core");
  });

  test("boxKey aligns with the package node id (the layout ClusterBox key)", () => {
    expect(h.boxKey("package:pkg:npm:web")).toBe("pkg:npm:web");
  });

  test("snapshot over package grouping is valid (every node grouped, no NO_GROUP here)", () => {
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "package", ids);
    expect(snap.groupIds.length).toBe(2);
    expect([...snap.directGroupByNode].every((g) => g !== NO_GROUP)).toBe(true);
  });
});

// ── Community grouping ───────────────────────────────────────────────────────
describe("communityGrouping — flat, singletons ungrouped, namespaced", () => {
  // {a,b,c} clique, {x,y,z} clique, weak bridge; plus a lone node `solo`.
  const graph: GraphModel = {
    nodes: ["a", "b", "c", "x", "y", "z", "solo"].map(file),
    edges: [
      E("a", "b"),
      E("b", "c"),
      E("a", "c"),
      E("x", "y"),
      E("y", "z"),
      E("x", "z"),
      E("c", "x"),
    ],
  };
  const h = communityGrouping(graph);

  test("ids are namespaced 'community:'", () => {
    for (const r of h.roots()) expect(r.startsWith("community:")).toBe(true);
  });

  test("members of one community share a group; the two cliques differ", () => {
    expect(h.groupOfNode("a")).toBe(h.groupOfNode("b"));
    expect(h.groupOfNode("a")).toBe(h.groupOfNode("c"));
    expect(h.groupOfNode("x")).toBe(h.groupOfNode("y"));
    expect(h.groupOfNode("a")).not.toBe(h.groupOfNode("x"));
  });

  test("a singleton community is ungrouped (null) — avoids a sea of one-node boxes", () => {
    expect(h.groupOfNode("solo")).toBeNull();
  });

  test("boxKey strips the namespace to the bare community id (smart's ClusterBox key)", () => {
    const gid = h.groupOfNode("a")!;
    expect(h.boxKey(gid)).toBe(gid.slice("community:".length));
  });

  test("snapshot: the singleton node is NO_GROUP; the clique nodes are grouped", () => {
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "community", ids);
    expect(snap.directGroupByNode[ids.indexOf("solo")]).toBe(NO_GROUP);
    expect(snap.directGroupByNode[ids.indexOf("a")]).not.toBe(NO_GROUP);
  });
});

// ── Facet grouping ───────────────────────────────────────────────────────────
const envDescriptor: DimensionDescriptor = {
  key: "env",
  label: "Environment",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "client", label: "Client" },
    { value: "server", label: "Server" },
  ],
  providerIds: ["core"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

const withFacet = (path: string, facets: Record<string, string[]>) => ({
  ...file(path),
  facets,
});

describe("facetGrouping (single cardinality) — one group per value", () => {
  const graph: GraphModel = {
    nodes: [
      withFacet("a.ts", { env: ["client"] }),
      withFacet("b.ts", { env: ["client"] }),
      withFacet("c.ts", { env: ["server"] }),
      file("d.ts"), // no env value → unclassified
    ],
    edges: [],
  };
  const h = facetGrouping(graph, envDescriptor)!;

  test("ids are namespaced 'facet:<key>:<value>'", () => {
    expect(sorted(h.roots())).toEqual(["facet:env:client", "facet:env:server"]);
  });

  test("groupOfNode maps a node to its value group", () => {
    expect(h.groupOfNode("a.ts")).toBe("facet:env:client");
    expect(h.groupOfNode("c.ts")).toBe("facet:env:server");
  });

  test("a node with no value is unclassified (null) — missing.group", () => {
    expect(h.groupOfNode("d.ts")).toBeNull();
  });

  test("boxKey is the namespaced id (a facet group is its own layout ClusterBox)", () => {
    expect(h.boxKey("facet:env:client")).toBe("facet:env:client");
  });

  test("label is the value (or its declared label not required here)", () => {
    expect(h.label("facet:env:client")).toBe("client");
  });
});

describe("facetGrouping — multi-valued behavior", () => {
  const multi = (path: string, vals: string[]) => withFacet(path, { runtime: vals });
  const graph: GraphModel = {
    nodes: [multi("a.ts", ["node", "bun"]), multi("b.ts", ["node"]), multi("c.ts", ["deno"])],
    edges: [],
  };

  test("'primary' (choose first) yields exactly ONE group per node", () => {
    const d: DimensionDescriptor = {
      ...envDescriptor,
      key: "runtime",
      cardinality: "multi",
      domain: "open",
      values: [],
      grouping: { mode: "primary", choose: "first" },
    };
    const h = facetGrouping(graph, d)!;
    expect(h.groupOfNode("a.ts")).toBe("facet:runtime:node"); // first of [node,bun]
    expect(h.groupOfNode("c.ts")).toBe("facet:runtime:deno");
    // Exactly one group per node ⇒ the snapshot never duplicates a node.
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "facet:runtime", ids);
    expect(snap.directGroupByNode.length).toBe(ids.length);
  });

  test("'combination' yields one synthetic group per value-SET", () => {
    const d: DimensionDescriptor = {
      ...envDescriptor,
      key: "runtime",
      cardinality: "multi",
      domain: "open",
      values: [],
      grouping: { mode: "combination" },
    };
    const h = facetGrouping(graph, d)!;
    // a.ts → the {bun,node} combination (values sorted, joined); b.ts → {node}.
    expect(h.groupOfNode("a.ts")).toBe("facet:runtime:bun+node");
    expect(h.groupOfNode("b.ts")).toBe("facet:runtime:node");
    expect(h.groupOfNode("a.ts")).not.toBe(h.groupOfNode("b.ts"));
  });

  test("'disabled' (default for multi) is NOT groupable — facetGrouping returns null", () => {
    const d: DimensionDescriptor = {
      ...envDescriptor,
      key: "runtime",
      cardinality: "multi",
      domain: "open",
      values: [],
      grouping: { mode: "disabled" },
    };
    expect(facetGrouping(graph, d)).toBeNull();
  });
});

// ── Synthetic-None grouping ──────────────────────────────────────────────────
describe("syntheticNoneGrouping — internal safety hierarchy (components → communities)", () => {
  // Two connected components: {a-b-c} and {x-y}; plus an isolated node `iso`.
  const graph: GraphModel = {
    nodes: ["a", "b", "c", "x", "y", "iso"].map(file),
    edges: [E("a", "b"), E("b", "c"), E("x", "y")],
  };
  const h: GroupingHierarchy = syntheticNoneGrouping(graph);

  test("ids are namespaced 'component:' (roots) and 'community:' (children)", () => {
    for (const r of h.roots()) expect(r.startsWith("component:")).toBe(true);
  });

  test("EVERY node — including an isolated one — gets a representation path", () => {
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "none", ids);
    // The safety hierarchy must classify every visible node: none are NO_GROUP.
    for (const id of ids) {
      const g = snap.directGroupByNode[ids.indexOf(id)];
      expect(g).not.toBe(NO_GROUP);
      // …and that group resolves to a non-empty outermost-first path.
      expect(groupPath(snap, g).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("nodes in the same connected component share a top-level component root", () => {
    expect(h.groupOfNode("a")).not.toBeNull();
    // a and b are in the same component → their group paths share the same root.
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "none", ids);
    const rootOf = (id: string) => groupPath(snap, snap.directGroupByNode[ids.indexOf(id)])[0];
    expect(rootOf("a")).toBe(rootOf("b"));
    expect(rootOf("a")).toBe(rootOf("c"));
    expect(rootOf("a")).not.toBe(rootOf("x"));
  });

  test("the isolated node is its own component (still gets a path)", () => {
    const ids = graph.nodes.map((n) => n.id);
    const snap = buildGroupingSnapshot(h, "none", ids);
    const rootOf = (id: string) => groupPath(snap, snap.directGroupByNode[ids.indexOf(id)])[0];
    expect(rootOf("iso")).not.toBe(rootOf("a"));
    expect(rootOf("iso")).not.toBe(rootOf("x"));
  });
});
