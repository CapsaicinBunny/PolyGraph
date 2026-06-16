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
  type: { label: "Type", palette: "yellow", color: "#eab308" },
  enum: { label: "Enum", palette: "orange", color: "#f97316" },
  function: { label: "Function", palette: "blue", color: "#3b82f6" },
  component: { label: "Component", palette: "green", color: "#22c55e" },
  variable: { label: "Variable", palette: "teal", color: "#14b8a6" },
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

/** Symbol node kinds the user can toggle (excludes file, which always shows, and external). */
export const FILTERABLE_NODE_KINDS: NodeKind[] = [
  "class",
  "interface",
  "type",
  "enum",
  "function",
  "component",
  "variable",
];

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
