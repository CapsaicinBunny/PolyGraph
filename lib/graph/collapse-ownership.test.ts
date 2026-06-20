// Phase C0 regression gate — the ownership invariants the three-layer collapse model
// exists to guarantee (spec "Three-layer collapse" / "Ownership rule"). These exercise
// the exact state transitions the Explorer wiring performs — writing user intent, writing
// the bootstrap safety seed, and updating ONLY the camera selection from a computeCut
// result — through the same pure functions Explorer/Canvas use, so the guarantees are
// pinned without a DOM:
//   (a) a camera/onCut update never mutates the user intent;
//   (b) a bootstrap-closed directory can still be opened by the camera selection;
//   (c) collapse-all then a zoom does not lose the user's collapse (intent wins).

import { describe, expect, test } from "bun:test";
import { type CollapseIntent, compose, type GroupId } from "./collapse-model";
import { collapseClusters } from "./collapse";
import { computeCut } from "./lod-cut";
import { allDirectoryGroupIds, directoryGroupId, toDirectoryBoxKeys } from "./grouping";
import { buildDirTree } from "./hierarchy";
import type { Box } from "./lod-screen";
import { directoryLodSelection } from "./lod-selection";
import type { GraphModel } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});

// drivers/{net/{a,b,c}, gpu/{d,e}}, fs/{f,g}
const graph: GraphModel = {
  nodes: [
    file("drivers/net/a.c"),
    file("drivers/net/b.c"),
    file("drivers/net/c.c"),
    file("drivers/gpu/d.c"),
    file("drivers/gpu/e.c"),
    file("fs/f.c"),
    file("fs/g.c"),
  ],
  edges: [],
};

const tree = buildDirTree(graph);
const boxes = new Map<string, Box>([
  ["drivers", { x: 0, y: 0, w: 2000, h: 2000 }],
  ["drivers/net", { x: 0, y: 0, w: 1000, h: 1000 }],
  ["drivers/gpu", { x: 0, y: 1100, w: 1000, h: 800 }],
  ["fs", { x: 5000, y: 0, w: 1000, h: 1000 }],
]);
const vp = { w: 800, h: 600 };

/** The camera step: measure a cut and hand up the open-dir selection (as onCut does). */
const cameraSelection = (cam: { x: number; y: number; scale: number }): Set<GroupId> => {
  const cut = computeCut(tree, boxes, cam, vp, { openPx: 220, maxCards: 1000 });
  return directoryLodSelection(cut, graph);
};

/** The effective collapsed set (bare paths) the scene pipeline consumes. */
const effective = (
  intent: CollapseIntent,
  bootstrapClosed: ReadonlySet<GroupId>,
  selection: ReadonlySet<GroupId>,
) => toDirectoryBoxKeys(compose({ intent, bootstrapClosed, selection }));

describe("C0 (a) — a camera/onCut update never mutates user intent", () => {
  test("computing and applying a camera selection leaves intentByMode byte-identical", () => {
    // The user has drilled: drivers open, its children folded (intent only).
    const intent: CollapseIntent = new Map([
      [directoryGroupId("drivers"), "open"],
      [directoryGroupId("drivers/net"), "closed"],
      [directoryGroupId("drivers/gpu"), "closed"],
    ]);
    const before = new Map(intent); // snapshot

    // A zoom fires: the camera produces a selection and Explorer stores it in the
    // selection layer ONLY. The intent map is never passed to that path.
    const selection = cameraSelection({ x: 0, y: 0, scale: 1 });
    compose({ intent, bootstrapClosed: allDirectoryGroupIds(graph), selection });

    expect([...intent.entries()]).toEqual([...before.entries()]); // untouched
  });

  test("directoryLodSelection (the onCut payload) does not touch the intent map", () => {
    const intent: CollapseIntent = new Map([[directoryGroupId("drivers"), "closed"]]);
    const before = new Map(intent);
    // Several camera positions, each producing a selection — none may mutate intent.
    for (const cam of [
      { x: 0, y: 0, scale: 0.05 },
      { x: 0, y: 0, scale: 1 },
      { x: -5000, y: 0, scale: 1 },
    ]) {
      cameraSelection(cam);
    }
    expect([...intent.entries()]).toEqual([...before.entries()]);
  });
});

describe("C0 (b) — a bootstrap-closed directory can still be opened by the camera selection", () => {
  test("a directory the bootstrap closed renders open once the camera selection opens it", () => {
    const bootstrapClosed = allDirectoryGroupIds(graph); // everything closed (the safety net)
    // Before any camera input: drivers is bootstrap-closed → collapsed.
    const initial = effective(new Map(), bootstrapClosed, new Set());
    expect(initial.has("drivers")).toBe(true);

    // Zoom so drivers fills the view: the camera selection opens it (and drivers/net).
    const selection = cameraSelection({ x: 0, y: 0, scale: 1 });
    expect(selection.has(directoryGroupId("drivers"))).toBe(true);

    const after = effective(new Map(), bootstrapClosed, selection);
    expect(after.has("drivers")).toBe(false); // the camera opened the bootstrap-closed dir
    expect(after.has("drivers/net")).toBe(false);
    // …and the directory the camera left collapsed stays collapsed.
    expect(after.has("drivers/gpu")).toBe(true);
    expect(after.has("fs")).toBe(true);
  });
});

describe("C0 (c) — collapse-all then a zoom does not lose the user's collapse (intent wins)", () => {
  test("a user-closed top directory stays collapsed through a subsequent camera cut", () => {
    // "Collapse all" writes 'closed' intent on the top-level dirs and turns the auto layers
    // off (bootstrap ∅). The user then re-enables LOD / a zoom fires (selection non-empty).
    const intent: CollapseIntent = new Map([
      [directoryGroupId("drivers"), "closed"],
      [directoryGroupId("fs"), "closed"],
    ]);

    // The camera would love to open drivers (it fills the view) — selection includes it.
    const selection = cameraSelection({ x: 0, y: 0, scale: 1 });
    expect(selection.has(directoryGroupId("drivers"))).toBe(true);

    // But user intent wins: drivers stays collapsed. The collapse the user asked for is
    // NOT lost by the zoom — the pre-C0 defect (camera overwrites the whole set) is fixed.
    const collapsed = effective(intent, new Set(), selection);
    expect(collapsed.has("drivers")).toBe(true);
    expect(collapsed.has("fs")).toBe(true);

    // And it really renders as the two top-level aggregates, nothing opened underneath.
    const ids = collapseClusters(graph, collapsed)
      .nodes.map((n) => n.id)
      .sort();
    expect(ids).toEqual(["drivers#__agg__", "fs#__agg__"]);
  });

  test("the camera CAN still open a different directory the user did not pin", () => {
    // collapse-all pinned only fs; drivers is left to the auto/camera layers.
    const intent: CollapseIntent = new Map([[directoryGroupId("fs"), "closed"]]);
    const bootstrapClosed = allDirectoryGroupIds(graph);
    const selection = cameraSelection({ x: 0, y: 0, scale: 1 }); // opens drivers, drivers/net

    const collapsed = effective(intent, bootstrapClosed, selection);
    expect(collapsed.has("fs")).toBe(true); // user-pinned, stays closed
    expect(collapsed.has("drivers")).toBe(false); // camera opened it
    expect(collapsed.has("drivers/net")).toBe(false);
  });
});

describe("C0 — the three layers reproduce the pre-refactor camera cut exactly (no intent)", () => {
  // The behavior-preservation guarantee: with no user intent, composing the camera
  // selection collapses the SAME graph the old path did — feeding computeCut straight to
  // collapseClusters. (The effective set may carry redundant deeper entries that
  // collapseClusters absorbs identically; the rendered scene — what the user sees — is what
  // must match, so we compare the rendered node ids, not the raw sets.)
  test("rendered scene === computeCut-rendered scene across camera positions", () => {
    const bootstrapClosed = allDirectoryGroupIds(graph);
    const rendered = (collapsed: Set<string>) =>
      collapseClusters(graph, collapsed)
        .nodes.map((n) => n.id)
        .sort();
    for (const cam of [
      { x: 0, y: 0, scale: 0.05 },
      { x: 0, y: 0, scale: 1 },
      { x: -5000, y: 0, scale: 1 },
      { x: 0, y: 0, scale: 3 },
    ]) {
      const cut = computeCut(tree, boxes, cam, vp, { openPx: 220, maxCards: 1000 });
      const selection = directoryLodSelection(cut, graph);
      const eff = effective(new Map(), bootstrapClosed, selection);
      expect(rendered(eff)).toEqual(rendered(cut));
    }
  });
});
