// Parse and validate a `.polygraph.yml` document into a normalized
// PolygraphConfig. The raw format is deliberately forgiving — selectors may be a
// bare glob, a list, or an object — so all of that flexibility is collapsed here
// and the rest of the codebase only deals with the strict types in ./schema.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { DimensionIndex } from "../graph/dimension-index";
import type { Environment, NodeCategory, NodeKind, NodeRole } from "../graph/types";
import {
  ConfigError,
  type ConfigValidationProblem,
  type CycleRule,
  type DependencyRule,
  type NodeSelector,
  type PolygraphConfig,
  type Rule,
  type Severity,
  type Thresholds,
  type Validation,
} from "./schema";

export const DEFAULT_CONFIG_FILENAME = ".polygraph.yml";

const NODE_KINDS = new Set<NodeKind>([
  "file",
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
  "namespace",
  "module",
  "function",
  "method",
  "constructor",
  "accessor",
  "component",
  "macro",
  "variable",
  "constant",
  "field",
  "property",
  "annotation",
  "external",
]);
const NODE_ROLES = new Set<NodeRole>([
  "react-component",
  "vue-component",
  "svelte-component",
  "angular-component",
  "angular-service",
  "angular-module",
  "angular-directive",
  "angular-pipe",
  "ecs-component",
  "ecs-system",
  "ecs-entity",
]);
const ENVIRONMENTS = new Set<Environment>(["client", "server"]);
const CATEGORIES = new Set<NodeCategory>(["ui", "feature"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce `string | string[]` to a clean string[], erroring on anything else. */
function toStringArray(value: unknown, where: string): string[] {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new ConfigError(`${where}: expected a non-empty string, got ${JSON.stringify(v)}`);
    }
    return v.trim();
  });
}

function validateEnum<T>(values: string[], allowed: Set<T>, where: string): T[] {
  return values.map((v) => {
    if (!allowed.has(v as T)) {
      throw new ConfigError(
        `${where}: unknown value "${v}". Allowed: ${[...(allowed as Set<string>)].sort().join(", ")}`,
      );
    }
    return v as T;
  });
}

function emptySelector(): NodeSelector {
  return { paths: [], kinds: [], roles: [], environments: [], categories: [], facets: {} };
}

/** Mirror a legacy typed field's values into the generic `facets` store. */
function mirrorFacet(sel: NodeSelector, canonicalKey: string, values: string[]): void {
  if (values.length > 0) sel.facets[canonicalKey] = [...values];
}

/** Parse a generic `facets: { key: string|string[] }` object (no registry check). */
function parseFacetsObject(value: unknown, where: string): Record<string, string[]> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${where}: expected a mapping of dimension key to value(s)`);
  }
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(value)) {
    out[key] = toStringArray(value[key], `${where}.${key}`);
  }
  return out;
}

/**
 * Parse a selector. A bare string / string[] is shorthand for `{ path: … }`.
 * An object may carry any of path/kind/role/environment/category (legacy typed
 * fields, validated against their enums) or a generic `facets` map (registry-keyed,
 * checked only POST-analysis). Legacy fields are mirrored into `facets` under their
 * canonical key. The result must select at least one constraint.
 */
function parseSelector(value: unknown, where: string): NodeSelector {
  const sel = emptySelector();

  if (typeof value === "string" || Array.isArray(value)) {
    sel.paths = toStringArray(value, where);
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const at = `${where}.${key}`;
      switch (key) {
        case "path":
        case "paths":
          sel.paths = toStringArray(value[key], at);
          break;
        case "kind":
        case "kinds":
          sel.kinds = validateEnum(toStringArray(value[key], at), NODE_KINDS, at);
          mirrorFacet(sel, "kind", sel.kinds);
          break;
        case "role":
        case "roles":
          sel.roles = validateEnum(toStringArray(value[key], at), NODE_ROLES, at);
          mirrorFacet(sel, "role", sel.roles);
          break;
        case "environment":
        case "environments":
          sel.environments = validateEnum(toStringArray(value[key], at), ENVIRONMENTS, at);
          mirrorFacet(sel, "env", sel.environments);
          break;
        case "category":
        case "categories":
          sel.categories = validateEnum(toStringArray(value[key], at), CATEGORIES, at);
          mirrorFacet(sel, "category", sel.categories);
          break;
        case "facets":
          // Generic facets merge onto any legacy-mirrored keys (last write wins per key).
          Object.assign(sel.facets, parseFacetsObject(value[key], at));
          break;
        default:
          throw new ConfigError(`${at}: unknown selector field "${key}"`);
      }
    }
  } else {
    throw new ConfigError(`${where}: expected a glob string, list, or selector object`);
  }

  // A selector must constrain something: a path glob or at least one facet value.
  const facetValueCount = Object.values(sel.facets).reduce((n, vs) => n + vs.length, 0);
  if (sel.paths.length + facetValueCount === 0) {
    throw new ConfigError(`${where}: selector matches nothing (no facets given)`);
  }
  return sel;
}

function parseSeverity(value: unknown, where: string, fallback: Severity): Severity {
  if (value === undefined) return fallback;
  if (value !== "error" && value !== "warning") {
    throw new ConfigError(
      `${where}: severity must be "error" or "warning", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseRule(raw: unknown, index: number): Rule {
  const where = `rules[${index}]`;
  if (!isPlainObject(raw)) throw new ConfigError(`${where}: expected a mapping`);

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  if (!name) throw new ConfigError(`${where}: a "name" is required`);

  // A "cycles" key marks a cycle rule; otherwise it's a dependency rule.
  if ("cycles" in raw) {
    const severity = parseSeverity(raw.cycles, `${where}.cycles`, "error");
    const rule: CycleRule = { type: "cycle", name, severity };
    if (raw.scope !== undefined) rule.scope = parseSelector(raw.scope, `${where}.scope`);
    return rule;
  }

  if (raw.from === undefined || raw.disallow === undefined) {
    throw new ConfigError(
      `${where} ("${name}"): a rule needs either "cycles", or both "from" and "disallow"`,
    );
  }
  const rule: DependencyRule = {
    type: "dependency",
    name,
    severity: parseSeverity(raw.severity, `${where}.severity`, "error"),
    from: parseSelector(raw.from, `${where}.from`),
    disallow: parseSelector(raw.disallow, `${where}.disallow`),
  };
  return rule;
}

function parseThresholds(raw: unknown): Thresholds {
  const thresholds: Thresholds = { severity: "error" };
  if (raw === undefined) return thresholds;
  if (!isPlainObject(raw)) throw new ConfigError(`thresholds: expected a mapping`);

  const num = (v: unknown, where: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ConfigError(`${where}: expected a non-negative number, got ${JSON.stringify(v)}`);
    }
    return v;
  };
  for (const key of Object.keys(raw)) {
    switch (key) {
      case "maxFanOut":
        thresholds.maxFanOut = num(raw[key], `thresholds.${key}`);
        break;
      case "maxDependencyDepth":
        thresholds.maxDependencyDepth = num(raw[key], `thresholds.${key}`);
        break;
      case "severity":
        thresholds.severity = parseSeverity(raw[key], "thresholds.severity", "error");
        break;
      default:
        throw new ConfigError(`thresholds: unknown field "${key}"`);
    }
  }
  return thresholds;
}

const DEFAULT_VALIDATION: Validation = { unknownFacet: "warning" };

function parseValidation(raw: unknown): Validation {
  if (raw === undefined) return { ...DEFAULT_VALIDATION };
  if (!isPlainObject(raw)) throw new ConfigError(`validation: expected a mapping`);
  const validation: Validation = { ...DEFAULT_VALIDATION };
  for (const key of Object.keys(raw)) {
    switch (key) {
      case "unknownFacet":
        validation.unknownFacet = parseSeverity(raw[key], "validation.unknownFacet", "warning");
        break;
      default:
        throw new ConfigError(`validation: unknown field "${key}"`);
    }
  }
  return validation;
}

/** Parse a config document (already-decoded YAML/JSON value) into a PolygraphConfig. */
export function parseConfig(doc: unknown): PolygraphConfig {
  if (doc === null || doc === undefined) {
    return { rules: [], thresholds: { severity: "error" }, validation: { ...DEFAULT_VALIDATION } };
  }
  if (!isPlainObject(doc)) throw new ConfigError("Top level of config must be a mapping");

  for (const key of Object.keys(doc)) {
    if (key !== "rules" && key !== "thresholds" && key !== "validation") {
      throw new ConfigError(
        `Unknown top-level field "${key}" (expected "rules", "thresholds", or "validation")`,
      );
    }
  }

  let rules: Rule[] = [];
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) throw new ConfigError(`"rules" must be a list`);
    rules = doc.rules.map((r, i) => parseRule(r, i));
  }
  return {
    rules,
    thresholds: parseThresholds(doc.thresholds),
    validation: parseValidation(doc.validation),
  };
}

/** Every NodeSelector a config references, paired with its location label. */
function selectorsOf(config: PolygraphConfig): { selector: NodeSelector; where: string }[] {
  const out: { selector: NodeSelector; where: string }[] = [];
  config.rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if (rule.type === "dependency") {
      out.push({ selector: rule.from, where: `${at}.from` });
      out.push({ selector: rule.disallow, where: `${at}.disallow` });
    } else if (rule.scope) {
      out.push({ selector: rule.scope, where: `${at}.scope` });
    }
  });
  return out;
}

/**
 * POST-analysis validation: check every selector facet against the built dimension
 * registry. An unknown facet key, or a value outside a closed dimension's domain,
 * is reported at `config.validation.unknownFacet` severity (default "warning").
 * Open dimensions (folder/language) accept any value. Returns an empty array when
 * the config is consistent with the registry. Pure — never throws.
 */
export function validateConfigAgainstIndex(
  config: PolygraphConfig,
  index: DimensionIndex,
): ConfigValidationProblem[] {
  const severity = config.validation.unknownFacet;
  const problems: ConfigValidationProblem[] = [];

  for (const { selector, where } of selectorsOf(config)) {
    for (const [key, values] of Object.entries(selector.facets)) {
      const descriptor = index.descriptor(key);
      if (!descriptor) {
        problems.push({
          severity,
          where: `${where}.facets.${key}`,
          message: `Unknown dimension "${key}" — not contributed by any provider in this graph`,
        });
        continue;
      }
      if (descriptor.domain !== "closed") continue; // open domains admit any value
      const domain = new Set(descriptor.values.map((v) => v.value));
      for (const value of values) {
        if (!domain.has(value)) {
          problems.push({
            severity,
            where: `${where}.facets.${key}`,
            message: `Value "${value}" is outside the closed domain of dimension "${key}" (allowed: ${[...domain].sort().join(", ")})`,
          });
        }
      }
    }
  }

  return problems;
}

/** Read and parse a `.polygraph.yml` file from disk. */
export async function loadConfigFile(path: string): Promise<PolygraphConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError(
      `Failed to parse YAML in ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseConfig(doc);
}
