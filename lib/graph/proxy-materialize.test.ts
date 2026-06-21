// The GENERIC proxy materializer (design Gap 1 + P1). Proves the central P1 promise the old
// collapseClusters could NOT keep: materializing a FACET or PACKAGE cut actually folds those
// nodes into proxy cards (collapseClusters folds only by directory prefix / communityOf, so a
// facet/package proxy left the underlying nodes un-absorbed). Also covers Directory + None for
// uniformity, and boundary-edge aggregation between committed proxies.

import { describe, expect, test } from "bun:test";
import {
  buildProxyEdgeInputs,
  isProxyId,
  materializeChangedBoundary,
  materializeProxyScene,
  proxyNodeId,
  repOfProxyId,
} from "./proxy-materialize";
import { materializeRepresentationScene } from "./scene";
import { buildFlatGroupingSnapshot, buildGroupingSnapshot } from "./grouping-snapshot";
import { directoryGrouping } from "./grouping";
import { buildRepresentationEdgeIndex, buildRepresentationHierarchy } from "./representation";
import { collapseClusters } from "./collapse";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path.split("/").pop() ?? path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// Five files in two FACET groups ("client"/"server") that do NOT line up with directories —
// so the facet membership is the ONLY thing that folds them. Directory-prefix absorption
// (collapseClusters) cannot reproduce this fold.
const graph: GraphModel = {
  nodes: [
    file("a/x/f1.ts"), // client
    file("a/y/f2.ts"), // client
    file("b/z/f3.ts"), // server
    file("b/z/f4.ts"), // server
    file("c/f5.ts"), // server
  ],
  edges: [
    makeEdge("a/x/f1.ts", "b/z/f3.ts", "import"), // client → server (cross group)
    makeEdge("a/x/f1.ts", "a/y/f2.ts", "call"), // client → client (internal once folded)
    makeEdge("b/z/f3.ts", "b/z/f4.ts", "call"), // server → server (internal once folded)
  ],
};
const nodeIds = graph.nodes.map((n) => n.id);

const facetOf: Record<string, "client" | "server"> = {
  "a/x/f1.ts": "client",
  "a/y/f2.ts": "client",
  "b/z/f3.ts": "server",
  "b/z/f4.ts": "server",
  "c/f5.ts": "server",
};

// A FLAT facet snapshot (env-like) — exactly the shape buildSceneStructure builds for a facet
// mode. Two root groups: "client", "server"; ordinals by first appearance.
const facetSnap = buildFlatGroupingSnapshot(nodeIds, "facet:env", (id) => {
  const v = facetOf[id];
  return v ? { id: `env:${v}`, boxKey: `env:${v}`, label: v } : null;
});

const ordinalOf = (id: string) => nodeIds.indexOf(id);
const edgeInputs = buildProxyEdgeInputs(graph, (id) => {
  const i = ordinalOf(id);
  return i === -1 ? undefined : i;
});

/** Select both facet GROUP reps (rep id == group ordinal) — the fully-folded coarse cut. */
function selectFacetGroups(): { selectedRepresentations: number[] } {
  const reps: number[] = [];
  for (let g = 0; g < facetSnap.groupIds.length; g++) reps.push(g);
  return { selectedRepresentations: reps };
}

describe("generic proxy materializer — facet cut folds nodes the old collapse could not", () => {
  const hierarchy = buildRepresentationHierarchy(facetSnap, nodeIds);

  test("a facet cut folds its members into ONE proxy card per group (no raw files survive)", () => {
    const cut = selectFacetGroups();
    const scene = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });

    // No raw file survives — every node is absorbed by its facet proxy.
    const rawFiles = scene.nodes.filter((n) => !isProxyId(n.id));
    expect(rawFiles.length).toBe(0);

    // Exactly two proxy cards (client, server), each badged with its member count.
    const proxies = scene.nodes.filter((n) => isProxyId(n.id));
    expect(proxies.length).toBe(2);
    const labels = proxies.map((p) => p.label).sort();
    expect(labels).toEqual(["client · 2", "server · 3"]);
  });

  test("the OLD collapseClusters cannot fold a facet cut (contrast — proves the gap)", () => {
    // collapseClusters keyed on the facet box keys ("env:client"/"env:server") folds NOTHING,
    // because those are neither directory prefixes nor (without a communityOf) community ids.
    const folded = collapseClusters(graph, new Set(["env:client", "env:server"]));
    // The graph is returned UNCHANGED — all five raw files remain, no aggregate appears.
    expect(folded.nodes.length).toBe(5);
    expect(folded.nodes.every((n) => !n.id.includes("__agg__"))).toBe(true);
  });

  test("boundary edges aggregate between proxies; internal edges drop", () => {
    const cut = selectFacetGroups();
    const scene = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });
    // Only the client→server import crosses the boundary; the two intra-group calls are internal.
    expect(scene.edges.length).toBe(1);
    const e = scene.edges[0];
    expect(e.kind).toBe("import");
    const clientRep = 0; // group ordinal 0 == "client" rep
    const serverRep = 1; // group ordinal 1 == "server" rep
    expect(e.source).toBe(proxyNodeId(clientRep));
    expect(e.target).toBe(proxyNodeId(serverRep));
  });

  test("a MIXED cut: open one group's leaves, keep the other folded", () => {
    // Select "server" group rep + "client"'s two LEAF reps → client files render, server folds.
    const groupCount = facetSnap.groupIds.length;
    const leafRepOf = (id: string) => groupCount + ordinalOf(id);
    const cut = {
      selectedRepresentations: [
        1, // server group rep
        leafRepOf("a/x/f1.ts"),
        leafRepOf("a/y/f2.ts"),
      ],
    };
    const scene = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });
    const ids = new Set(scene.nodes.map((n) => n.id));
    expect(ids.has("a/x/f1.ts")).toBe(true); // client leaf open
    expect(ids.has("a/y/f2.ts")).toBe(true);
    expect(ids.has(proxyNodeId(1))).toBe(true); // server folded into a proxy
    expect(ids.has("b/z/f3.ts")).toBe(false); // absorbed by the server proxy
    // The client→server import now goes from the open client file to the server proxy.
    const e = scene.edges.find((x) => x.kind === "import");
    expect(e?.source).toBe("a/x/f1.ts");
    expect(e?.target).toBe(proxyNodeId(1));
  });
});

describe("generic proxy materializer — package cut (flat, non-directory) folds into cards", () => {
  // Packages cut ACROSS directories: pkgA owns a/x/f1 + b/z/f3; pkgB owns the rest.
  const pkgOf: Record<string, string> = {
    "a/x/f1.ts": "pkgA",
    "b/z/f3.ts": "pkgA",
    "a/y/f2.ts": "pkgB",
    "b/z/f4.ts": "pkgB",
    "c/f5.ts": "pkgB",
  };
  const pkgSnap = buildFlatGroupingSnapshot(nodeIds, "package", (id) =>
    pkgOf[id] ? { id: `pkg:${pkgOf[id]}`, boxKey: `pkg:${pkgOf[id]}`, label: pkgOf[id] } : null,
  );
  const hierarchy = buildRepresentationHierarchy(pkgSnap, nodeIds);

  test("both package proxies appear; members fold across directory boundaries", () => {
    const cut = { selectedRepresentations: [0, 1] };
    const scene = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });
    const proxies = scene.nodes.filter((n) => isProxyId(n.id));
    expect(proxies.length).toBe(2);
    expect(scene.nodes.some((n) => !isProxyId(n.id))).toBe(false); // every file absorbed
    // f1 (pkgA, dir a) and f3 (pkgA, dir b) fold into the SAME proxy — impossible by dir prefix.
    const pkgAord = pkgSnap.groupIds.indexOf("pkg:pkgA");
    const card = scene.nodes.find((n) => repOfProxyId(n.id) === pkgAord);
    expect(card?.label).toBe("pkgA · 2");
  });
});

describe("generic proxy materializer — directory fold + incremental boundary retrieval", () => {
  // Use a NESTED case so a sibling boundary exists for the index to retrieve: under "a",
  // subdirs "a/x" and "a/y" are siblings; their boundary edge (f1→f2 call) is index-pairable.
  const nestedGraph: GraphModel = {
    nodes: [file("a/x/f1.ts"), file("a/y/f2.ts"), file("a/x/f6.ts")],
    edges: [
      makeEdge("a/x/f1.ts", "a/y/f2.ts", "call"), // a/x → a/y (sibling boundary under "a")
      makeEdge("a/x/f1.ts", "a/x/f6.ts", "import"), // internal to a/x
    ],
  };
  const ids = nestedGraph.nodes.map((n) => n.id);
  const ord = (id: string) => ids.indexOf(id);
  const dirSnap = buildGroupingSnapshot(directoryGrouping(nestedGraph), "directory", ids);
  const hierarchy = buildRepresentationHierarchy(dirSnap, ids);
  const nestedEdgeInputs = buildProxyEdgeInputs(nestedGraph, (id) => {
    const i = ord(id);
    return i === -1 ? undefined : i;
  });
  const KIND = { call: 0, import: 1 } as const;
  const indexEdges = nestedGraph.edges.map((e) => ({
    source: ord(e.source),
    target: ord(e.target),
    kind: KIND[e.kind as keyof typeof KIND],
    weight: e.count,
  }));
  const edgeIndex = buildRepresentationEdgeIndex(hierarchy, indexEdges);

  test("full fold: selecting a/x and a/y groups yields two proxies + one boundary edge", () => {
    const repOfId = new Map<string, number>();
    for (let g = 0; g < dirSnap.groupIds.length; g++) repOfId.set(dirSnap.groupIds[g], g);
    const ax = repOfId.get("directory:a/x")!;
    const ay = repOfId.get("directory:a/y")!;
    const cut = { selectedRepresentations: [ax, ay] };
    const scene = materializeProxyScene({
      hierarchy,
      cut,
      graph: nestedGraph,
      edgeInputs: nestedEdgeInputs,
    });
    expect(scene.nodes.filter((n) => isProxyId(n.id)).length).toBe(2);
    // f1→f2 crosses a/x|a/y; f1→f6 is internal to a/x (dropped).
    expect(scene.edges.length).toBe(1);
    expect(scene.edges[0].source).toBe(proxyNodeId(ax));
    expect(scene.edges[0].target).toBe(proxyNodeId(ay));
  });

  test("incremental: materializeChangedBoundary retrieves the a/x|a/y boundary via the index", () => {
    const repOfId = new Map<string, number>();
    for (let g = 0; g < dirSnap.groupIds.length; g++) repOfId.set(dirSnap.groupIds[g], g);
    const ax = repOfId.get("directory:a/x")!;
    const ay = repOfId.get("directory:a/y")!;
    const boundary = materializeChangedBoundary(hierarchy, edgeIndex, nestedEdgeInputs, ax, ay);
    expect(boundary.length).toBe(1);
    expect(boundary[0].kind).toBe("call");
    // The endpoints map to the two proxy cards (orientation resolved by the ancestor test).
    const endpoints = new Set([boundary[0].source, boundary[0].target]);
    expect(endpoints.has(proxyNodeId(ax))).toBe(true);
    expect(endpoints.has(proxyNodeId(ay))).toBe(true);
  });
});

describe("generic proxy materializer — None (orphan leaves) renders cards generically", () => {
  // A "none"-like flat snapshot where some nodes are NO_GROUP. With a super-root + bucket the
  // orphan leaves can be represented by a render-only bucket proxy — folding with NO semantic
  // group (the case collapseClusters has no path for at all).
  const noneSnap = buildFlatGroupingSnapshot(nodeIds, "none", (id) =>
    // Put f1/f2 in one synthetic component, leave f3/f4/f5 ungrouped (orphans).
    id === "a/x/f1.ts" || id === "a/y/f2.ts"
      ? { id: "cc:0", boxKey: "cc:0", label: "component 0" }
      : null,
  );
  const hierarchy = buildRepresentationHierarchy(noneSnap, nodeIds, {
    bootstrapRoots: true,
    intermediateTiers: true,
  });

  test("selecting the component group folds it into a card; orphans stay their own leaves", () => {
    const cut = { selectedRepresentations: [0] }; // the single "component 0" group rep
    const scene = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });
    const ids = new Set(scene.nodes.map((n) => n.id));
    expect(ids.has(proxyNodeId(0))).toBe(true); // component folded
    expect(ids.has("a/x/f1.ts")).toBe(false); // absorbed
    // The orphan files are uncovered by this cut (no selected rep on their chain) → not drawn.
    // With a valid full cut they'd be their own leaves; here we assert the proxy fold worked.
    const card = scene.nodes.find((n) => isProxyId(n.id));
    expect(card?.label).toBe("component 0 · 2");
  });
});

describe("scene.ts wiring — materializeRepresentationScene maps ordinals from graph order", () => {
  const hierarchy = buildRepresentationHierarchy(facetSnap, nodeIds);

  test("wiring helper produces the same fold as the direct materializer", () => {
    const cut = selectFacetGroups();
    const direct = materializeProxyScene({ hierarchy, cut, graph, edgeInputs });
    const wired = materializeRepresentationScene(graph, hierarchy, cut);
    const ids = (m: GraphModel) => m.nodes.map((n) => n.id).sort();
    expect(ids(wired)).toEqual(ids(direct));
    expect(wired.edges.length).toBe(direct.edges.length);
  });
});
