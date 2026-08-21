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
 *
 * `facets` is the generic, registry-driven store keyed by canonical dimension key
 * (`kind`, `role`, `env`, `category`, `rust.visibility`, …). The legacy typed
 * arrays (`kinds`/`roles`/`environments`/`categories`) are kept as a compatibility
 * projection — the loader mirrors them INTO `facets` under their canonical key —
 * so old configs and old consumers keep working while matching reads `facets`.
 *
 * Spec note: these legacy arrays are part of the "remove legacy named fields"
 * Phase D deliverable, DEFERRED to Phase E in lock-step with the GraphNode legacy
 * fields (see graph/types.ts). They stay until every consumer reads only `facets`.
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
  /**
   * Generic dimension constraints keyed by canonical dimension key. Each key's
   * values are OR-ed; distinct keys are AND-ed (and AND with `paths`). Legacy
   * typed fields above are mirrored here under `kind`/`role`/`env`/`category`.
   */
  facets: Record<string, string[]>;
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

/**
 * How the loader treats config that can only be checked against a built graph —
 * a selector facet whose key isn't a registered dimension, or whose value falls
 * outside a closed dimension's domain. PRE-analysis (syntax/types/known built-in
 * keys) always errors; this severity governs the POST-analysis registry check.
 */
export interface Validation {
  /** Severity for an unknown facet key / out-of-domain value. Default "warning". */
  unknownFacet: Severity;
}

export interface PolygraphConfig {
  rules: Rule[];
  thresholds: Thresholds;
  validation: Validation;
}

/** A user-facing config problem (bad shape, unknown field, …). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A POST-analysis validation finding: a selector referenced a facet key/value the
 * built dimension registry doesn't know. `severity` is `config.validation.unknownFacet`.
 */
export interface ConfigValidationProblem {
  severity: Severity;
  /** Where in the config (e.g. `rules[0].from.facets.rust.visibility`). */
  where: string;
  message: string;
}
