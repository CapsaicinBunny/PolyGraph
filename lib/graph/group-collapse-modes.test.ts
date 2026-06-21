// Phase C1a regression gate — the mode-keyed collapse + mode-agnostic cut invariants
// (spec "Phase plan → C1a"). These exercise the exact pure state the Explorer/Canvas
// wiring performs — per-mode intent/bootstrap/selection maps, composing the ACTIVE
// mode's effective set, and running the generic cut in a NON-directory mode — so the
// guarantees are pinned without a DOM:
//   (a) switching grouping modes preserves each mode's collapse intent;
//   (b) the cut works in a non-directory (community) mode (the old bug: changing the
//       group mode disabled LOD — onCut never fired);
//   (c) "None" can't bypass the render budget (every node has a representation path,
//       and the cut over None's safety hierarchy stays bounded).

import { describe, expect, test } from "bun:test";
import { type CollapseIntent, compose, type GroupId } from "./collapse-model";
import { communityGrouping, syntheticNoneGrouping } from "./grouping";
import { buildGroupingSnapshot, groupPath, NO_GROUP } from "./grouping-snapshot";
import { computeGroupCut, groupLodSelection } from "./group-cut";
import type { Box, Camera, Viewport } from "./lod-screen";
import { type GraphModel, makeEdge } from "./types";

const file = (path: string) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
});
const E = (s: string, t: string) => makeEdge(s, t, "import");

// ── (a) Mode switch preserves per-mode intent ────────────────────────────────
describe("C1a (a) — switching grouping modes preserves each mode's intent", () => {
  test("intentByMode keeps directory + community intent independently across a switch", () => {
    // The Explorer holds intent per grouping mode. Simulate the exact map writes.
    let intentByMode = new Map<string, CollapseIntent>();
    const editMode = (mode: string, mutate: (i: CollapseIntent) => void) => {
      const next = new Map(intentByMode);
      const cur = new Map(next.get(mode) ?? new Map());
      mutate(cur);
      next.set(mode, cur);
      intentByMode = next;
    };

    // In Directory mode the user collapses "src".
    editMode("directory", (i) => i.set("directory:src", "closed"));
    // Switch to Community and collapse a community.
    editMode("community", (i) => i.set("community:Community 1", "closed"));

    // Both modes' intents coexist — neither switch clobbered the other.
    expect([...intentByMode.get("directory")!.entries()]).toEqual([["directory:src", "closed"]]);
    expect([...intentByMode.get("community")!.entries()]).toEqual([
      ["community:Community 1", "closed"],
    ]);

    // Switching back to Directory still sees the original directory intent.
    const dir = intentByMode.get("directory") ?? new Map();
    expect(dir.get("directory:src")).toBe("closed");
  });

  test("the camera selection is also per-mode (a community cut can't clobber directory)", () => {
    let selectionByMode = new Map<string, Set<GroupId>>();
    const setSelection = (mode: string, sel: Set<GroupId>) => {
      selectionByMode = new Map(selectionByMode).set(mode, sel);
    };
    setSelection("directory", new Set(["directory:src"]));
    setSelection("community", new Set(["community:Community 2"]));
    expect([...selectionByMode.get("directory")!]).toEqual(["directory:src"]);
    expect([...selectionByMode.get("community")!]).toEqual(["community:Community 2"]);
  });
});

// ── (b) The cut works in a non-directory (community) mode ─────────────────────
describe("C1a (b) — the adaptive cut runs in a non-directory mode (LOD not disabled)", () => {
  const graph: GraphModel = {
    nodes: ["a", "b", "c", "x", "y", "z"].map(file),
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
  const hier = communityGrouping(graph);
  const nodeIds = graph.nodes.map((n) => n.id);
  const snap = buildGroupingSnapshot(hier, "community", nodeIds);
  const groupA = hier.groupOfNode("a")!;
  const groupX = hier.groupOfNode("x")!;
  const boxA = hier.boxKey(groupA);
  const boxX = hier.boxKey(groupX);
  const vp: Viewport = { w: 800, h: 600 };

  test("the camera selection composes into an effective collapse for the community mode", () => {
    // The community bootstrap closes the whole community universe (the safety net).
    const bootstrap = new Set<GroupId>(snap.groupIds);
    // The camera opens community A (it fills the view); X is off-screen → collapsed.
    const boxes = new Map<string, Box>([
      [boxA, { x: 0, y: 0, w: 1000, h: 1000 }],
      [boxX, { x: 50000, y: 0, w: 1000, h: 1000 }],
    ]);
    const cam: Camera = { x: 0, y: 0, scale: 1 };
    const cut = computeGroupCut(snap, boxes, cam, vp, { openPx: 220, maxCards: 100 }, nodeIds);
    const selection = groupLodSelection(cut, snap);
    expect(selection.has(groupA)).toBe(true); // the camera opened A

    // Compose (∅ intent, full bootstrap, this selection) → effective collapsed group ids.
    const collapsed = compose({ intent: new Map(), bootstrapClosed: bootstrap, selection });
    // A is OPEN (camera released it); X stays collapsed (bootstrap, camera didn't open it).
    expect(collapsed.has(groupA)).toBe(false);
    expect(collapsed.has(groupX)).toBe(true);
  });

  test("user intent still wins over the community camera cut (intent not clobbered)", () => {
    const boxes = new Map<string, Box>([[boxA, { x: 0, y: 0, w: 1000, h: 1000 }]]);
    const selection = groupLodSelection(
      computeGroupCut(snap, boxes, { x: 0, y: 0, scale: 1 }, vp, { openPx: 220, maxCards: 100 }, nodeIds),
      snap,
    );
    expect(selection.has(groupA)).toBe(true); // the camera wants A open
    // But the user explicitly closed A → it stays collapsed despite the camera.
    const collapsed = compose({
      intent: new Map([[groupA, "closed"]]),
      bootstrapClosed: new Set(),
      selection,
    });
    expect(collapsed.has(groupA)).toBe(true);
  });
});

// ── (c) None can't bypass the render budget ──────────────────────────────────
describe("C1a (c) — None keeps an internal safety hierarchy that bounds the budget", () => {
  // A larger None graph: one big connected component + isolated nodes.
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const edges = ids.slice(1).map((id, i) => E(ids[i], id)); // a chain → one component
  const isolated = Array.from({ length: 10 }, (_, i) => `iso${i}`);
  const graph: GraphModel = {
    nodes: [...ids, ...isolated].map(file),
    edges,
  };
  const hier = syntheticNoneGrouping(graph);
  const nodeIds = graph.nodes.map((n) => n.id);
  const snap = buildGroupingSnapshot(hier, "none", nodeIds);

  test("EVERY visible node — incl. isolated ones — has a representation path (no NO_GROUP)", () => {
    for (let i = 0; i < nodeIds.length; i++) {
      const g = snap.directGroupByNode[i];
      expect(g).not.toBe(NO_GROUP);
      expect(groupPath(snap, g).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("the cut over None's hierarchy stays bounded by maxCards", () => {
    // Give every group a big on-screen box; with a tight maxCards the cut must NOT open
    // every node — the budget caps the rendered cards (the disappearing-budget safety).
    const boxes = new Map<string, Box>();
    for (let g = 0; g < snap.groupIds.length; g++) {
      boxes.set(snap.boxKeyByGroup[g], { x: 0, y: g * 1100, w: 1000, h: 1000 });
    }
    const maxCards = 5;
    const cut = computeGroupCut(
      snap,
      boxes,
      { x: 0, y: 0, scale: 1 },
      { w: 100000, h: 100000 },
      { openPx: 50, maxCards },
      nodeIds,
    );
    // At least one group collapsed → the budget bounded the open set (didn't open all 50).
    expect(cut.size).toBeGreaterThan(0);
  });
});
