import type { NodeKind } from "./types";
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
};

export const EDGE_STYLES: Record<ViewEdgeKind, KindStyle> = {
  import: { label: "Import", palette: "gray", color: "#64748b" },
  call: { label: "Call", palette: "blue", color: "#3b82f6" },
  extends: { label: "Extends", palette: "purple", color: "#a855f7" },
  implements: { label: "Implements", palette: "cyan", color: "#06b6d4" },
  renders: { label: "Renders", palette: "green", color: "#22c55e" },
  contains: { label: "Contains", palette: "gray", color: "#475569" },
};

/** Edge kinds the user can filter (excludes the synthetic "contains"). */
export const FILTERABLE_EDGE_KINDS: ViewEdgeKind[] = [
  "import",
  "call",
  "extends",
  "implements",
  "renders",
];
