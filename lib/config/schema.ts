// Normalized, validated shape of a `.polygraph.yml` config. The raw YAML is
// intentionally forgiving (a selector can be a bare glob string, a single glob,
// a list, or an object); the loader collapses all of that into these types so
// the rules engine only ever sees one canonical form.

import type { Environment, NodeCategory, NodeKind, NodeRole } from "../graph/types";

export type Severity = "error" | "warning";

/**
 * Selects a set of graph nodes. Facets are AND-ed (a node must satisfy every
 * facet that is present); within a facet the entries are OR-ed. An empty
 * selector matches nothing and is rejected by the loader.
 */
export interface NodeSelector {
  /** Globs on the node's relative `filePath`; any match qualifies. */
  paths: string[];
  /** Structural kinds (file, class, component, …); any match qualifies. */
  kinds: NodeKind[];
  /** Architectural roles (react-component, ecs-system, …). */
  roles: NodeRole[];
  /** Runtime environment from `"use client"` / `"use server"`. */
  environments: Environment[];
  /** Coarse purpose: ui vs feature. */
  categories: NodeCategory[];
}

/** "from X must not depend on Y" — a forbidden dependency edge. */
export interface DependencyRule {
  type: "dependency";
  name: string;
  severity: Severity;
  from: NodeSelector;
  disallow: NodeSelector;
}

/** "no cycles" — strongly-connected components within an optional scope. */
export interface CycleRule {
  type: "cycle";
  name: string;
  severity: Severity;
  /** When set, only cycles whose members all fall inside this scope are flagged. */
  scope?: NodeSelector;
}

export type Rule = DependencyRule | CycleRule;

export interface Thresholds {
  /** Flag nodes that depend on more than this many distinct nodes. */
  maxFanOut?: number;
  /** Flag when the longest dependency chain exceeds this many levels. */
  maxDependencyDepth?: number;
  /** Severity applied to threshold breaches. Defaults to "error". */
  severity: Severity;
}

export interface PolygraphConfig {
  rules: Rule[];
  thresholds: Thresholds;
}

/** A user-facing config problem (bad shape, unknown field, …). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
