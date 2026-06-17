import { describe, expect, test } from "bun:test";
import type { Scene, SceneEdge, SceneNode } from "../graph/scene";
import { boundsOf, DARK_THEME, sceneToSVG } from "./svg";

const snode = (id: string, x: number, y: number): SceneNode => ({
  id,
  x,
  y,
  width: 200,
  height: 56,
  kind: "file",
  label: id,
  glyph: "",
  shape: "doc",
  color: "#3366cc",
  symbolCount: 0,
  isFile: true,
  isExternal: false,
});

const sedge = (source: string, target: string): SceneEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  kind: "import",
  color: "#888",
  dashed: false,
  toExternal: false,
});

const scene: Scene = {
  nodes: [snode("a.ts", 0, 0), snode("b.ts", 400, 200)],
  edges: [sedge("a.ts", "b.ts")],
  positions: new Map(),
  clusters: [{ id: "c", x: -10, y: -10, width: 620, height: 280, depth: 0, label: "src" }],
};

describe("boundsOf", () => {
  test("covers nodes and clusters plus padding", () => {
    const b = boundsOf(scene);
    expect(b.minX).toBeLessThan(-10); // cluster left minus padding
    expect(b.width).toBeGreaterThan(600);
  });

  test("empty scene returns a safe default", () => {
    const b = boundsOf({ nodes: [], edges: [], positions: new Map(), clusters: [] });
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });
});

describe("sceneToSVG", () => {
  test("emits an svg with a viewBox, nodes, an edge, and an arrow marker", () => {
    const svg = sceneToSVG(scene);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain('stroke="#3366cc"'); // node border color
    expect(svg).toContain("<line "); // the edge
    expect(svg).toContain('marker-end="url(#arrow-import)"');
    expect(svg).toContain("<text"); // labels
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  test("respects the theme background", () => {
    expect(sceneToSVG(scene, { theme: DARK_THEME })).toContain(`fill="${DARK_THEME.background}"`);
  });

  test("escapes label text", () => {
    const s: Scene = {
      ...scene,
      nodes: [{ ...snode("x", 0, 0), label: "a<b>&c" }],
      edges: [],
      clusters: [],
    };
    const svg = sceneToSVG(s);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
  });
});
