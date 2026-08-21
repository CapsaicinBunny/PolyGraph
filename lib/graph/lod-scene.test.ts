import { describe, expect, test } from "bun:test";
import { aggregateNodeId } from "./collapse";
import { cameraBand, proxyBoxes, sceneBoxes, shouldFit } from "./lod-scene";
import { buildGroupingSnapshot } from "./grouping-snapshot";
import { directoryGrouping } from "./grouping";
import { buildRepresentationHierarchy } from "./representation";
import { proxyNodeId } from "./proxy-materialize";
import type { GraphModel } from "./types";
import type { Scene } from "./scene";

const aggNode = (dir: string, x: number, y: number) => ({
  id: aggregateNodeId(dir),
  kind: "file" as const,
  x,
  y,
  width: 200,
  height: 56,
  label: dir,
  glyph: "",
  shape: "doc" as const,
  color: "#000",
  symbolCount: 0,
  isFile: true,
  isExternal: false,
});

describe("sceneBoxes", () => {
  test("maps open-dir cluster boxes and collapsed-dir aggregate cards", () => {
    const scene: Scene = {
      nodes: [aggNode("a/x", 10, 20)],
      edges: [],
      positions: new Map(),
      clusters: [{ id: "a", x: 0, y: 0, width: 1000, height: 800, depth: 0, label: "a" }],
    };
    const boxes = sceneBoxes(scene);
    expect(boxes.get("a")).toEqual({ x: 0, y: 0, w: 1000, h: 800 }); // open dir → cluster box
    expect(boxes.get("a/x")).toEqual({ x: 10, y: 20, w: 200, h: 56 }); // collapsed dir → card
  });

  test("ignores non-aggregate nodes", () => {
    const scene: Scene = {
      nodes: [{ ...aggNode("a/x", 0, 0), id: "a/x/real.ts" }],
      edges: [],
      positions: new Map(),
      clusters: [],
    };
    expect(sceneBoxes(scene).size).toBe(0);
  });
});

describe("proxyBoxes (rep-cut materializer scene → group box keys)", () => {
  const file = (path: string) => ({
    id: path,
    kind: "file" as const,
    label: path,
    filePath: path,
    line: 0,
    parentFile: path,
  });
  const graph: GraphModel = { nodes: [file("a/x/f1.c"), file("b/z/f4.c")], edges: [] };
  const nodeIds = graph.nodes.map((n) => n.id);
  const snap = buildGroupingSnapshot(directoryGrouping(graph), "directory", nodeIds);
  const hierarchy = buildRepresentationHierarchy(snap, nodeIds, { nodeCost: () => 1 });

  // The proxy card node shape (mirrors proxyNodeFor's output + the scene node geometry fields).
  const proxyCard = (rep: number, x: number, y: number) => ({
    id: proxyNodeId(rep),
    kind: "file" as const,
    x,
    y,
    width: 200,
    height: 56,
    label: "proxy",
    glyph: "",
    shape: "doc" as const,
    color: "#000",
    symbolCount: 0,
    isFile: true,
    isExternal: false,
  });

  test("maps a collapsed group's proxy card back to its group box key", () => {
    // Group ordinal 0 is the first group in the snapshot; its rep is repOfGroup[0].
    const g = 0;
    const rep = hierarchy.repOfGroup[g];
    const boxKey = snap.boxKeyByGroup[g];
    const scene: Scene = {
      nodes: [proxyCard(rep, 12, 34)],
      edges: [],
      positions: new Map(),
      clusters: [],
    };
    const boxes = proxyBoxes(scene, hierarchy);
    expect(boxes.get(boxKey)).toEqual({ x: 12, y: 34, w: 200, h: 56 });
  });

  test("still reads open-group cluster boxes (parity with sceneBoxes)", () => {
    const scene: Scene = {
      nodes: [],
      edges: [],
      positions: new Map(),
      clusters: [{ id: "a", x: 0, y: 0, width: 500, height: 400, depth: 0, label: "a" }],
    };
    expect(proxyBoxes(scene, hierarchy).get("a")).toEqual({ x: 0, y: 0, w: 500, h: 400 });
  });

  test("ignores non-proxy nodes (raw files draw as themselves — no box key)", () => {
    const scene: Scene = {
      nodes: [{ ...proxyCard(0, 0, 0), id: "a/x/f1.c" }],
      edges: [],
      positions: new Map(),
      clusters: [],
    };
    expect(proxyBoxes(scene, hierarchy).size).toBe(0);
  });
});

describe("cameraBand", () => {
  test("quantizes zoom into discrete bands", () => {
    expect(cameraBand(1)).toBe(0);
    // Same band for small moves, different once zoom crosses ~1.5x.
    expect(cameraBand(1.2)).toBe(cameraBand(1));
    expect(cameraBand(1.6)).toBe(cameraBand(1) + 1);
    expect(cameraBand(0.6)).toBe(cameraBand(1) - 1);
  });

  test("is monotonic in scale and safe near zero", () => {
    expect(cameraBand(4)).toBeGreaterThan(cameraBand(1));
    expect(cameraBand(0.01)).toBeLessThan(cameraBand(1));
    expect(Number.isFinite(cameraBand(0))).toBe(true);
  });
});

describe("shouldFit", () => {
  test("undefined signature (adaptive off) always fits — today's behavior", () => {
    expect(shouldFit(undefined, undefined)).toBe(true);
    expect(shouldFit(undefined, "anything")).toBe(true);
  });

  test("fits only when the fit signature changes (cut-only changes preserve camera)", () => {
    expect(shouldFit("graphA|file|filters", "graphA|file|filters")).toBe(false);
    expect(shouldFit("graphA|package|filters", "graphA|file|filters")).toBe(true);
  });
});
