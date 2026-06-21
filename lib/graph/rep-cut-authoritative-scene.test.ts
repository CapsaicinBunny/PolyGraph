// The AUTHORITATIVE rep-cut render path (design "Retire compose()" / impl point 5):
//
//   intent → solver constraints → LodCut → proxy materializer → scene
//
// These tests pin the contract the spec mandates: once the rep cut is the authority, the rendered
// SceneStructure is built DIRECTLY from the materializer's folded proxy GraphModel — NOT routed
// through compose() → collapsedClusters → collapseClusters(). So the structure's nodes ARE the
// materializer's valid-antichain output (one representative per visible node), and NONE of the
// directory-aggregate ids collapseClusters would have produced appear.

import { describe, expect, test } from "bun:test";
import { directoryGrouping } from "./grouping";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import type { Box, Camera, Viewport } from "./lod-screen";
import { buildSceneRepresentationCut, DEFAULT_REP_LOD_OPTIONS } from "./lod-representation-cut";
import { isAggregateId } from "./collapse";
import { isProxyId, repOfProxyId } from "./proxy-materialize";
import {
  buildSceneStructureFromModel,
  materializeRepresentationScene,
  type SceneFilters,
} from "./scene";
import { FILTERABLE_EDGE_KINDS } from "./visual";
import type { FacetKey } from "./dimensions";
import type { FacetSelection } from "./facet-selection";
import { representativeOf } from "./representation";
import type { CollapseIntent } from "./collapse-model";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

const graph: GraphModel = {
  nodes: [file("a/x/f1.c"), file("a/x/f2.c"), file("a/y/f3.c"), file("b/z/f4.c"), file("b/z/f5.c")],
  edges: [makeEdge("a/x/f1.c", "b/z/f4.c", "import")],
};
const nodeIds = graph.nodes.map((n) => n.id);
const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
const vp: Viewport = { w: 800, h: 600 };

const boxes = (): Map<string, Box> =>
  new Map<string, Box>([
    ["a", { x: 0, y: 0, w: 1000, h: 1000 }],
    ["a/x", { x: 0, y: 0, w: 500, h: 500 }],
    ["a/y", { x: 0, y: 600, w: 500, h: 400 }],
    ["b", { x: 5000, y: 0, w: 1000, h: 1000 }],
    ["b/z", { x: 5000, y: 0, w: 1000, h: 1000 }],
  ]);

const opts = { ...DEFAULT_REP_LOD_OPTIONS, openPx: 220, maxCards: 800, nodeBudget: 2500 };

function filters(overrides: Partial<SceneFilters> = {}): SceneFilters {
  return {
    showExternal: false,
    enabledFacets: new Map<FacetKey, FacetSelection>(),
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    enabledFolders: new Set(["a", "b", "/"]),
    enabledLanguages: new Set(["C", "{}", "", "?"]),
    ...overrides,
  };
}

/** Run the authoritative path end to end for a given camera. */
function authoritative(cam: Camera) {
  const r = buildSceneRepresentationCut({
    snapshot: snap,
    nodeIds,
    boxes: boxes(),
    cam,
    vp,
    intent: new Map() as CollapseIntent,
    options: opts,
  });
  const folded = materializeRepresentationScene(graph, r.hierarchy, r.cut);
  const structure = buildSceneStructureFromModel(
    folded,
    graph,
    new Set<string>(), // expanded
    filters(),
    "force",
    "LR",
    "directory",
    1,
    new Set(nodeIds), // visibleNodeIds (post-filter projection)
    `gen0`, // cut signature salt
  );
  return { r, folded, structure };
}

describe("authoritative rep-cut scene (materializer output, not collapseClusters)", () => {
  test("zoomed out: the structure's nodes ARE the folded proxy cards — no collapseClusters aggregates", () => {
    const { folded, structure } = authoritative({ x: 0, y: 0, scale: 0.01 } as Camera);
    const structureIds = new Set(structure.nodes.map((n) => n.id));
    const foldedIds = new Set(folded.nodes.map((n) => n.id));
    // The rendered structure is exactly the materializer's antichain output.
    expect(structureIds).toEqual(foldedIds);
    // Every rendered card is a generic proxy (the top groups folded), not a raw file.
    expect(structure.nodes.length).toBeGreaterThan(0);
    for (const n of structure.nodes) expect(isProxyId(n.id)).toBe(true);
    // NONE of collapseClusters' directory-aggregate ids appear — compose/collapse is not in the path.
    for (const id of structureIds) expect(isAggregateId(id)).toBe(false);
    // No raw file survives at the coarse cut.
    for (const id of nodeIds) expect(structureIds.has(id)).toBe(false);
  });

  test("zoomed into 'a': a's on-screen files render as themselves while 'b' stays a proxy card", () => {
    // The cut now reads the STABLE proxy bounds (a layout-independent treemap), NOT the live
    // engine boxes. In that layout `a` fills the LEFT of the world canvas (x≈[8,2456], the full
    // height) and `b` the RIGHT (x≈[2456,4088]). At scale 1 / origin the viewport (800×600) sits
    // over `a`'s top-left: a/x's files are on-screen and render verbatim, while a/y (below the
    // viewport) and all of `b` (right of it) stay folded into proxy cards. (With the old live
    // boxes `b` sat at x=5000 and a was only 1000 tall, so the whole of `a` opened — that
    // geometry no longer drives the cut.)
    const { folded, structure } = authoritative({ x: 0, y: 0, scale: 1 } as Camera);
    const ids = new Set(structure.nodes.map((n) => n.id));
    // The structure mirrors the materializer's fold exactly.
    expect(ids).toEqual(new Set(folded.nodes.map((n) => n.id)));
    // a/x's files are present verbatim (a/x opened on-screen); b's files are absorbed into a proxy.
    expect(ids.has("a/x/f1.c")).toBe(true);
    expect(ids.has("b/z/f4.c")).toBe(false);
    // The off-screen b subtree (and the off-screen a/y) stand in as proxy cards.
    const proxyCards = [...ids].filter((id) => isProxyId(id));
    expect(proxyCards.length).toBeGreaterThanOrEqual(1);
  });

  test("the rendered scene is a VALID ANTICHAIN — every visible node represented exactly once", () => {
    const { r, structure } = authoritative({ x: 0, y: 0, scale: 1 } as Camera);
    const selected = new Set(r.cut.selectedRepresentations);
    const isSelected = (rep: number) => selected.has(rep);
    const structureIds = new Set(structure.nodes.map((n) => n.id));
    // For every original node, its active representative resolves to EXACTLY ONE rendered card:
    // either the node itself (own leaf rep selected) or the proxy that absorbs it.
    for (let ord = 0; ord < nodeIds.length; ord++) {
      const rep = representativeOf(r.hierarchy, ord, isSelected);
      expect(rep).toBeGreaterThanOrEqual(0); // covered (valid antichain — no uncovered node)
      const isProxy = r.hierarchy.columns.firstChildByRep[rep] !== -1;
      if (isProxy) {
        // The node is represented by its proxy card; the node's own id is absent.
        expect(structureIds.has(nodeIds[ord])).toBe(false);
        // And the proxy card carrying this rep is present.
        const proxyForThisRep = [...structureIds].some(
          (id) => isProxyId(id) && repOfProxyId(id) === rep,
        );
        expect(proxyForThisRep).toBe(true);
      } else {
        // The node renders as itself; no proxy stands in.
        expect(structureIds.has(nodeIds[ord])).toBe(true);
      }
    }
  });

  test("the authoritative structure does NOT depend on collapsedClusters (compose is out of the path)", () => {
    // buildSceneStructureFromModel has no collapsedClusters parameter at all: the fold is the
    // materializer's. Two calls with the SAME folded scene but no collapse input are identical.
    const { folded } = authoritative({ x: 0, y: 0, scale: 1 } as Camera);
    const build = () =>
      buildSceneStructureFromModel(
        folded,
        graph,
        new Set<string>(),
        filters(),
        "force",
        "LR",
        "directory",
        1,
        new Set(nodeIds),
        "gen0",
      );
    const a = build();
    const b = build();
    expect(a.nodes.map((n) => n.id).sort()).toEqual(b.nodes.map((n) => n.id).sort());
    // The layout-cache signature carries the cut identity salt (not ser(collapsedClusters)).
    expect(a.signature).toContain("rep:gen0");
    expect(a.signature).not.toContain("cc"); // no community-collapse term from the C1a path
  });

  test("an explicit edge between two folded proxies is aggregated into ONE boundary edge", () => {
    // Scale 0.054 is the coarsest level with visible group proxies under the STABLE bounds the
    // cut now reads: the import endpoints fold into the distinct leaf-group proxies a/x and b/z.
    // (At 0.01 both endpoints fold into the SINGLE super-root, making the edge internal → zero
    // boundary edges; the boundary only exists once the two ends sit in distinct selected
    // proxies.)
    const { structure } = authoritative({ x: 0, y: 0, scale: 0.054 } as Camera);
    // The lone import a/x/f1.c → b/z/f4.c crosses the proxy boundary; both ends are folded, so it
    // surfaces as a single aggregated edge between the two proxy cards.
    const importEdges = structure.edges.filter((e) => e.kind === "import");
    expect(importEdges.length).toBe(1);
    expect(isProxyId(importEdges[0].source)).toBe(true);
    expect(isProxyId(importEdges[0].target)).toBe(true);
  });
});
