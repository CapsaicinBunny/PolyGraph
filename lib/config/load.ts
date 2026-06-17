// Parse and validate a `.polygraph.yml` document into a normalized
// PolygraphConfig. The raw format is deliberately forgiving — selectors may be a
// bare glob, a list, or an object — so all of that flexibility is collapsed here
// and the rest of the codebase only deals with the strict types in ./schema.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { Environment, NodeCategory, NodeKind, NodeRole } from "../graph/types";
import {
  ConfigError,
  type CycleRule,
  type DependencyRule,
  type NodeSelector,
  type PolygraphConfig,
  type Rule,
  type Severity,
  type Thresholds,
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

const EMPTY_SELECTOR: NodeSelector = {
  paths: [],
  kinds: [],
  roles: [],
  environments: [],
  categories: [],
};

/**
 * Parse a selector. A bare string / string[] is shorthand for `{ path: … }`.
 * An object may carry any of path/kind/role/environment/category, each scalar
 * or list. The result must select at least one facet.
 */
function parseSelector(value: unknown, where: string): NodeSelector {
  const sel: NodeSelector = { ...EMPTY_SELECTOR };

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
          break;
        case "role":
        case "roles":
          sel.roles = validateEnum(toStringArray(value[key], at), NODE_ROLES, at);
          break;
        case "environment":
        case "environments":
          sel.environments = validateEnum(toStringArray(value[key], at), ENVIRONMENTS, at);
          break;
        case "category":
        case "categories":
          sel.categories = validateEnum(toStringArray(value[key], at), CATEGORIES, at);
          break;
        default:
          throw new ConfigError(`${at}: unknown selector field "${key}"`);
      }
    }
  } else {
    throw new ConfigError(`${where}: expected a glob string, list, or selector object`);
  }

  const facets =
    sel.paths.length +
    sel.kinds.length +
    sel.roles.length +
    sel.environments.length +
    sel.categories.length;
  if (facets === 0) throw new ConfigError(`${where}: selector matches nothing (no facets given)`);
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

/** Parse a config document (already-decoded YAML/JSON value) into a PolygraphConfig. */
export function parseConfig(doc: unknown): PolygraphConfig {
  if (doc === null || doc === undefined) return { rules: [], thresholds: { severity: "error" } };
  if (!isPlainObject(doc)) throw new ConfigError("Top level of config must be a mapping");

  for (const key of Object.keys(doc)) {
    if (key !== "rules" && key !== "thresholds") {
      throw new ConfigError(`Unknown top-level field "${key}" (expected "rules" or "thresholds")`);
    }
  }

  let rules: Rule[] = [];
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) throw new ConfigError(`"rules" must be a list`);
    rules = doc.rules.map((r, i) => parseRule(r, i));
  }
  return { rules, thresholds: parseThresholds(doc.thresholds) };
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
