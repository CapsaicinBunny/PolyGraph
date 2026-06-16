import type { ExternalKind, NodeKind, NodeRole } from "./types";
import type { ViewEdgeKind } from "../aggregate";

export interface KindStyle {
  label: string;
  /** Chakra color palette name. */
  palette: string;
  /** Hex used for raw SVG / React Flow handles where a palette token can't apply. */
  color: string;
}

export const NODE_STYLES: Record<NodeKind, KindStyle> = {
  file: { label: "File", palette: "gray", color: "#94a3b8" },
  class: { label: "Class", palette: "purple", color: "#a855f7" },
  interface: { label: "Interface", palette: "cyan", color: "#06b6d4" },
  struct: { label: "Struct", palette: "purple", color: "#6366f1" },
  trait: { label: "Trait", palette: "cyan", color: "#22d3ee" },
  protocol: { label: "Protocol", palette: "cyan", color: "#67e8f9" },
  enum: { label: "Enum", palette: "orange", color: "#f97316" },
  union: { label: "Union", palette: "purple", color: "#a78bfa" },
  record: { label: "Record", palette: "purple", color: "#818cf8" },
  object: { label: "Object", palette: "purple", color: "#c084fc" },
  type: { label: "Type", palette: "yellow", color: "#eab308" },
  namespace: { label: "Namespace", palette: "yellow", color: "#fbbf24" },
  module: { label: "Module", palette: "orange", color: "#f59e0b" },
  function: { label: "Function", palette: "blue", color: "#3b82f6" },
  method: { label: "Method", palette: "blue", color: "#60a5fa" },
  constructor: { label: "Constructor", palette: "blue", color: "#2563eb" },
  accessor: { label: "Accessor", palette: "cyan", color: "#38bdf8" },
  component: { label: "Component", palette: "green", color: "#22c55e" },
  macro: { label: "Macro", palette: "pink", color: "#ec4899" },
  variable: { label: "Variable", palette: "teal", color: "#14b8a6" },
  constant: { label: "Constant", palette: "green", color: "#84cc16" },
  field: { label: "Field", palette: "teal", color: "#2dd4bf" },
  property: { label: "Property", palette: "teal", color: "#5eead4" },
  annotation: { label: "Annotation", palette: "pink", color: "#f472b6" },
  external: { label: "External", palette: "gray", color: "#94a3b8" },
};

/** External (out-of-project) node colors, by source family. */
export const EXTERNAL_STYLES: Record<ExternalKind, KindStyle> = {
  npm: { label: "npm package", palette: "red", color: "#f87171" },
  node: { label: "Node builtin", palette: "green", color: "#4ade80" },
  deno: { label: "Deno API", palette: "blue", color: "#60a5fa" },
  bun: { label: "Bun API", palette: "pink", color: "#f472b6" },
};

/** Architectural roles detected by paradigm scanning. Color overrides kind when present. */
export const ROLE_STYLES: Record<NodeRole, KindStyle> = {
  "react-component": { label: "React component", palette: "cyan", color: "#22d3ee" },
  "vue-component": { label: "Vue component", palette: "green", color: "#42b883" },
  "svelte-component": { label: "Svelte component", palette: "orange", color: "#ff3e00" },
  "angular-component": { label: "Angular component", palette: "red", color: "#dd0031" },
  "angular-service": { label: "Angular service", palette: "red", color: "#f0506e" },
  "angular-module": { label: "Angular module", palette: "red", color: "#b52e31" },
  "angular-directive": { label: "Angular directive", palette: "red", color: "#e2533a" },
  "angular-pipe": { label: "Angular pipe", palette: "red", color: "#c026d3" },
  "ecs-component": { label: "ECS component", palette: "orange", color: "#f97316" },
  "ecs-system": { label: "ECS system", palette: "pink", color: "#ec4899" },
  "ecs-entity": { label: "ECS entity", palette: "yellow", color: "#eab308" },
};

export const EDGE_STYLES: Record<ViewEdgeKind, KindStyle> = {
  import: { label: "Import", palette: "gray", color: "#94a3b8" },
  call: { label: "Call", palette: "blue", color: "#60a5fa" },
  extends: { label: "Extends", palette: "purple", color: "#c084fc" },
  implements: { label: "Implements", palette: "cyan", color: "#22d3ee" },
  renders: { label: "Renders", palette: "green", color: "#4ade80" },
  instantiates: { label: "Instantiates", palette: "orange", color: "#fb923c" },
  has: { label: "Has-a", palette: "teal", color: "#2dd4bf" },
  injects: { label: "Injects", palette: "pink", color: "#f472b6" },
  contains: { label: "Contains", palette: "gray", color: "#475569" },
};

/**
 * Node kinds grouped into filter "layers" — abstraction bands the user can toggle
 * as a group (or individually). Excludes file (always shows) and external (its own
 * toolbar toggle). Parsers emit whatever fits; unused kinds just never appear.
 */
export const NODE_KIND_LAYERS: { label: string; kinds: NodeKind[] }[] = [
  {
    label: "Types",
    kinds: [
      "class",
      "interface",
      "struct",
      "trait",
      "protocol",
      "enum",
      "union",
      "record",
      "object",
      "type",
    ],
  },
  {
    label: "Callables",
    kinds: ["function", "method", "constructor", "accessor", "component", "macro"],
  },
  { label: "Members", kinds: ["field", "property", "variable", "constant", "annotation"] },
  { label: "Modules", kinds: ["module", "namespace"] },
];

/** Flat list of all filterable node kinds (derived from the layers). */
export const FILTERABLE_NODE_KINDS: NodeKind[] = NODE_KIND_LAYERS.flatMap((l) => l.kinds);

/** Edge kinds the user can filter (excludes the synthetic "contains"). */
export const FILTERABLE_EDGE_KINDS: ViewEdgeKind[] = [
  "import",
  "call",
  "extends",
  "implements",
  "renders",
  "instantiates",
  "has",
  "injects",
];

/**
 * Effective display style for a node: external source color for externals, else the
 * detected role color, else the structural kind color.
 */
export function nodeStyle(kind: NodeKind, role?: NodeRole, externalKind?: ExternalKind): KindStyle {
  if (kind === "external") return EXTERNAL_STYLES[externalKind ?? "npm"];
  if (role) return ROLE_STYLES[role];
  return NODE_STYLES[kind];
}

export const KIND_GLYPH: Record<NodeKind, string> = {
  file: "▣",
  class: "◆",
  interface: "◇",
  struct: "▤",
  trait: "✦",
  protocol: "◈",
  enum: "≣",
  union: "⊍",
  record: "▦",
  object: "◉",
  type: "𝓣",
  namespace: "❏",
  module: "❏",
  function: "ƒ",
  method: "ƒ",
  constructor: "⊕",
  accessor: "⇄",
  component: "⬡",
  macro: "!",
  variable: "▪",
  constant: "=",
  field: "▫",
  property: "◦",
  annotation: "@",
  external: "↗",
};

export const ROLE_GLYPH: Record<NodeRole, string> = {
  "react-component": "⬡",
  "vue-component": "▽",
  "svelte-component": "◤",
  "angular-component": "Ⓐ",
  "angular-service": "⚙",
  "angular-module": "▦",
  "angular-directive": "✦",
  "angular-pipe": "▸",
  "ecs-component": "◈",
  "ecs-system": "⚙",
  "ecs-entity": "◉",
};

/** The glyph to show for a node: external arrow, else role glyph, else kind glyph. */
export function glyphFor(kind: NodeKind, role?: NodeRole): string {
  if (kind === "external") return KIND_GLYPH.external;
  if (role) return ROLE_GLYPH[role];
  return KIND_GLYPH[kind];
}

/**
 * Vector icon shape drawn by the Vello renderer (Unicode glyphs aren't in the
 * bundled font, so cards draw real shapes instead). One of a small primitive set.
 */
export type IconShape =
  | "doc"
  | "diamond"
  | "diamond-o"
  | "rounded"
  | "bars"
  | "circle"
  | "hexagon"
  | "square"
  | "arrow";

const KIND_SHAPE: Record<NodeKind, IconShape> = {
  file: "doc",
  class: "diamond",
  interface: "diamond-o",
  struct: "square",
  trait: "diamond-o",
  protocol: "diamond-o",
  enum: "bars",
  union: "diamond",
  record: "square",
  object: "hexagon",
  type: "rounded",
  namespace: "hexagon",
  module: "hexagon",
  function: "circle",
  method: "circle",
  constructor: "circle",
  accessor: "circle",
  component: "hexagon",
  macro: "diamond",
  variable: "square",
  constant: "circle",
  field: "square",
  property: "rounded",
  annotation: "diamond",
  external: "arrow",
};

const ROLE_SHAPE: Record<NodeRole, IconShape> = {
  "react-component": "hexagon",
  "vue-component": "hexagon",
  "svelte-component": "hexagon",
  "angular-component": "hexagon",
  "angular-service": "circle",
  "angular-module": "square",
  "angular-directive": "diamond",
  "angular-pipe": "arrow",
  "ecs-component": "diamond",
  "ecs-system": "hexagon",
  "ecs-entity": "circle",
};

/** Icon shape for a node: external arrow, else role shape, else kind shape. */
export function iconShapeFor(kind: NodeKind, role?: NodeRole): IconShape {
  if (kind === "external") return "arrow";
  if (role) return ROLE_SHAPE[role];
  return KIND_SHAPE[kind];
}

/** A short language badge (code + brand color) drawn inside a file node's icon. */
export interface LangBadge {
  code: string;
  color: string;
}

const LANG_BADGES: { test: RegExp; code: string; color: string }[] = [
  { test: /\.tsx$/i, code: "TX", color: "#3178c6" },
  { test: /\.ts$|\.mts$|\.cts$/i, code: "TS", color: "#3178c6" },
  { test: /\.(jsx|js|mjs|cjs)$/i, code: "JS", color: "#eab308" },
  { test: /\.py$/i, code: "PY", color: "#3776ab" },
  { test: /\.rs$/i, code: "RS", color: "#f74c00" },
  { test: /\.go$/i, code: "GO", color: "#00add8" },
  { test: /\.java$/i, code: "JV", color: "#e76f00" },
  { test: /\.(kt|kts)$/i, code: "KT", color: "#7f52ff" },
  { test: /\.(scala|sc)$/i, code: "SC", color: "#c22d40" },
  { test: /\.vue$/i, code: "VU", color: "#42b883" },
  { test: /\.svelte$/i, code: "SV", color: "#ff3e00" },
];

/** The language badge for a file path, or null if the extension is unknown. */
export function languageBadge(filePath: string): LangBadge | null {
  for (const b of LANG_BADGES) {
    if (b.test.test(filePath)) return { code: b.code, color: b.color };
  }
  return null;
}
