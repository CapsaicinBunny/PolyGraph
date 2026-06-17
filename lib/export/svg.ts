// Render a positioned Scene to a standalone SVG string. The app's renderer is
// Vello/GPU, so SVG export is a faithful re-draw from the same Scene model
// (positioned nodes, edges, cluster boxes) rather than a DOM serialization.
// Pure and deterministic — given a Scene it always yields the same SVG.

import type { Scene, SceneNode } from "../graph/scene";

export interface SvgTheme {
  background: string;
  nodeFill: string;
  text: string;
  clusterStroke: string;
  clusterFill: string;
}

export const LIGHT_THEME: SvgTheme = {
  background: "#ffffff",
  nodeFill: "#ffffff",
  text: "#1f2933",
  clusterStroke: "#cbd5e1",
  clusterFill: "rgba(148,163,184,0.06)",
};

export const DARK_THEME: SvgTheme = {
  background: "#0b0e14",
  nodeFill: "#161b24",
  text: "#e5e9f0",
  clusterStroke: "#384152",
  clusterFill: "rgba(148,163,184,0.08)",
};

const PADDING = 32;

export interface SvgBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** Bounding box over all node rects and cluster boxes, plus padding. */
export function boundsOf(scene: Scene): SvgBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const n of scene.nodes) extend(n.x, n.y, n.width, n.height);
  for (const c of scene.clusters) extend(c.x, c.y, c.width, c.height);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 100, height: 100 };
  return {
    minX: minX - PADDING,
    minY: minY - PADDING,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const center = (n: SceneNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });

/** Point where the ray from a rect's center toward `to` crosses the rect border. */
function borderPoint(n: SceneNode, to: { x: number; y: number }): { x: number; y: number } {
  const c = center(n);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = n.width / 2;
  const hh = n.height / 2;
  // Scale the direction so it just touches the nearest vertical/horizontal edge.
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** Truncate a label to roughly fit the node width at the given font size. */
function fitLabel(label: string, width: number, fontSize: number): string {
  const max = Math.max(3, Math.floor((width - 16) / (fontSize * 0.6)));
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export interface SvgOptions {
  theme?: SvgTheme;
  fontFamily?: string;
}

/** Serialize a positioned Scene to an SVG document string. */
export function sceneToSVG(scene: Scene, options: SvgOptions = {}): string {
  const theme = options.theme ?? LIGHT_THEME;
  const font = options.fontFamily ?? "ui-sans-serif, system-ui, sans-serif";
  const b = boundsOf(scene);
  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${b.minY} ${b.width} ${b.height}" ` +
      `width="${Math.round(b.width)}" height="${Math.round(b.height)}" font-family="${font}">`,
  );
  out.push(
    `<rect x="${b.minX}" y="${b.minY}" width="${b.width}" height="${b.height}" fill="${theme.background}"/>`,
  );

  // Cluster boxes first (deepest last so nesting reads correctly).
  for (const c of [...scene.clusters].sort((a, z) => a.depth - z.depth)) {
    out.push(
      `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="8" ` +
        `fill="${theme.clusterFill}" stroke="${theme.clusterStroke}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${c.x + 8}" y="${c.y + 16}" font-size="11" fill="${theme.clusterStroke}">${esc(c.label)}</text>`,
    );
  }

  // Edges under nodes.
  for (const e of scene.edges) {
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (!s || !t) continue;
    const p1 = borderPoint(s, center(t));
    const p2 = borderPoint(t, center(s));
    const dash = e.dashed ? ' stroke-dasharray="4 3"' : "";
    out.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" ` +
        `stroke="${e.color}" stroke-width="1.5"${dash} marker-end="url(#arrow-${esc(e.kind)})"/>`,
    );
  }

  // Arrowhead markers, one per distinct edge color, defined after use is fine in SVG.
  const arrowKinds = new Map<string, string>();
  for (const e of scene.edges) arrowKinds.set(e.kind, e.color);
  out.push("<defs>");
  for (const [kind, color] of arrowKinds) {
    out.push(
      `<marker id="arrow-${esc(kind)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
        `markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`,
    );
  }
  out.push("</defs>");

  // Nodes on top.
  for (const n of scene.nodes) {
    const rx = n.isFile ? 8 : 6;
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${rx}" ` +
        `fill="${theme.nodeFill}" stroke="${n.color}" stroke-width="${n.isFile ? 2 : 1.5}"/>`,
    );
    const fontSize = n.isFile ? 13 : 12;
    out.push(
      `<text x="${n.x + n.width / 2}" y="${n.y + n.height / 2}" font-size="${fontSize}" ` +
        `fill="${theme.text}" text-anchor="middle" dominant-baseline="central">${esc(fitLabel(n.label, n.width, fontSize))}</text>`,
    );
  }

  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
