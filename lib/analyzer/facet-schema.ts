// The TypeScript/JavaScript provider's facet schema (Phase A).
//
// These descriptors are the catalog half of the dimension spine for the four
// facets the TS analyzer detects: role, category, env, runtime. The kernel merges
// them with the core's STRUCTURAL_DESCRIPTORS so every consumer projects from one
// catalog. Labels/colors are the **sole** source for the UI handshake — pulled
// from ROLE_STYLES where they already exist, so role styling never drifts.

import type { DimensionDescriptor, DimensionValue } from "../graph/dimensions";
import type { NodeRole } from "../graph/types";
import { ROLE_STYLES } from "../graph/visual";

/** Every detected architectural role, with its label + color from ROLE_STYLES. */
const ROLE_VALUES: DimensionValue[] = (Object.keys(ROLE_STYLES) as NodeRole[]).map((role) => ({
  value: role,
  label: ROLE_STYLES[role].label,
  color: ROLE_STYLES[role].color,
}));

/** Facet descriptors contributed by the TypeScript provider. */
export const TS_FACET_DESCRIPTORS: DimensionDescriptor[] = [
  {
    key: "role",
    label: "Role",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: ROLE_VALUES,
    providerIds: ["typescript"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  },
  {
    key: "category",
    label: "Category",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [
      { value: "ui", label: "UI", color: "#22c55e" },
      { value: "feature", label: "Feature", color: "#3b82f6" },
    ],
    providerIds: ["typescript"],
    defaultValue: "feature",
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  },
  {
    key: "env",
    label: "Environment",
    dimension: "facet",
    cardinality: "single",
    domain: "closed",
    values: [
      { value: "client", label: "Client", color: "#fb923c" },
      { value: "server", label: "Server", color: "#2dd4bf" },
    ],
    providerIds: ["typescript"],
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  },
  {
    key: "runtime",
    label: "Runtime",
    dimension: "facet",
    cardinality: "multi",
    domain: "closed",
    values: [
      { value: "node", label: "Node", color: "#4ade80" },
      { value: "deno", label: "Deno", color: "#60a5fa" },
      { value: "bun", label: "Bun", color: "#f472b6" },
    ],
    providerIds: ["typescript"],
    filterable: true,
    // Multi-valued → containment can't pick one group, so grouping is disabled
    // (filter/query only) and the dimension is not offered as a group-by.
    groupable: false,
    grouping: { mode: "disabled" },
    missing: { filter: "include", group: "unclassified" },
  },
];
