import type { NodeKind, NodeRole } from "./types";
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
  function: { label: "Function", palette: "blue", color: "#3b82f6" },
  component: { label: "Component", palette: "green", color: "#22c55e" },
  variable: { label: "Variable", palette: "teal", color: "#14b8a6" },
};

/** Architectural roles detected by paradigm scanning. Color overrides kind when present. */
export const ROLE_STYLES: Record<NodeRole, KindStyle> = {
  "react-component": { label: "React component", palette: "green", color: "#22c55e" },
  "ecs-component": { label: "ECS component", palette: "orange", color: "#f97316" },
  "ecs-system": { label: "ECS system", palette: "pink", color: "#ec4899" },
  "ecs-entity": { label: "ECS entity", palette: "yellow", color: "#eab308" },
};

export const EDGE_STYLES: Record<ViewEdgeKind, KindStyle> = {
  import: { label: "Import", palette: "gray", color: "#64748b" },
  call: { label: "Call", palette: "blue", color: "#3b82f6" },
  extends: { label: "Extends", palette: "purple", color: "#a855f7" },
  implements: { label: "Implements", palette: "cyan", color: "#06b6d4" },
  renders: { label: "Renders", palette: "green", color: "#22c55e" },
  instantiates: { label: "Instantiates", palette: "orange", color: "#f97316" },
  has: { label: "Has-a", palette: "teal", color: "#14b8a6" },
  injects: { label: "Injects", palette: "pink", color: "#ec4899" },
  contains: { label: "Contains", palette: "gray", color: "#475569" },
};

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

/** Effective display style for a node: its role style if detected, else its kind style. */
export function nodeStyle(kind: NodeKind, role?: NodeRole): KindStyle {
  return role ? ROLE_STYLES[role] : NODE_STYLES[kind];
}
