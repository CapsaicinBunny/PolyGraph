// Phase D — two-stage config validation.
//
// PRE-analysis (parseConfig): syntax/types/known built-in keys — errors hard,
// no registry needed. Legacy keys still validate against their enums AND mirror
// into the generic `facets` store under their canonical key. Generic `facets`
// keys/values are NOT checked here (they're dynamic).
//
// POST-analysis (validateConfigAgainstIndex): each selector facet is checked
// against the built DimensionIndex — unknown key or out-of-domain value yields a
// problem at `config.validation.unknownFacet` severity (default "warning").

import { describe, expect, test } from "bun:test";
import { buildDimensionIndex } from "../graph/dimension-index";
import {
  type DimensionCatalog,
  type DimensionDescriptor,
  STRUCTURAL_DESCRIPTORS,
} from "../graph/dimensions";
import { writeFacet } from "../graph/facets-write";
import type { GraphModel, GraphNode } from "../graph/types";
import { parseConfig, validateConfigAgainstIndex } from "./load";
import { ConfigError } from "./schema";

const RUST_VISIBILITY: DimensionDescriptor = {
  key: "rust.visibility",
  label: "Visibility",
  dimension: "facet",
  cardinality: "single",
  domain: "closed",
  values: [
    { value: "pub", label: "pub" },
    { value: "crate", label: "pub(crate)" },
    { value: "private", label: "private" },
  ],
  providerIds: ["rust"],
  filterable: true,
  groupable: true,
  grouping: { mode: "single" },
  missing: { filter: "include", group: "unclassified" },
};

function fileNode(filePath: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: filePath,
    kind: "file",
    label: filePath,
    filePath,
    line: 0,
    parentFile: filePath,
    ...extra,
  };
}

function indexWithRust(): ReturnType<typeof buildDimensionIndex> {
  const n = fileNode("crate/a.rs", { kind: "struct" });
  writeFacet(n, "rust.visibility", ["pub"]);
  const graph: GraphModel = { nodes: [n], edges: [] };
  const catalog: DimensionCatalog = { descriptors: [...STRUCTURAL_DESCRIPTORS, RUST_VISIBILITY] };
  return buildDimensionIndex(graph, catalog);
}

/** Like indexWithRust, but one node carries an UNDECLARED closed value ("protected"). */
function indexWithUndeclaredVisibility(): ReturnType<typeof buildDimensionIndex> {
  const a = fileNode("crate/a.rs", { kind: "struct" });
  writeFacet(a, "rust.visibility", ["pub"]);
  const b = fileNode("crate/b.rs", { kind: "struct" });
  // "protected" is NOT in RUST_VISIBILITY.values — admitted, surfaced declared:false.
  writeFacet(b, "rust.visibility", ["protected"]);
  const graph: GraphModel = { nodes: [a, b], edges: [] };
  const catalog: DimensionCatalog = { descriptors: [...STRUCTURAL_DESCRIPTORS, RUST_VISIBILITY] };
  return buildDimensionIndex(graph, catalog);
}

describe("PRE-analysis: generic facets in a selector", () => {
  test("a selector may carry a generic facets object", () => {
    const cfg = parseConfig({
      rules: [
        {
          name: "pub structs must not depend on private",
          from: { facets: { "rust.visibility": "pub" } },
          disallow: { facets: { "rust.visibility": ["private", "crate"] } },
        },
      ],
    });
    const r = cfg.rules[0];
    if (r.type === "dependency") {
      expect(r.from.facets["rust.visibility"]).toEqual(["pub"]);
      expect(r.disallow.facets["rust.visibility"]).toEqual(["private", "crate"]);
    }
  });

  test("a facets-only selector is not rejected as empty", () => {
    expect(() =>
      parseConfig({
        rules: [{ name: "x", from: { facets: { "rust.visibility": "pub" } }, disallow: "b/**" }],
      }),
    ).not.toThrow();
  });

  test("facets must be an object of string/string[] values", () => {
    expect(() =>
      parseConfig({ rules: [{ name: "x", from: { facets: "pub" }, disallow: "b/**" }] }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        rules: [{ name: "x", from: { facets: { k: 7 } }, disallow: "b/**" }],
      }),
    ).toThrow(/non-empty string/);
  });

  test("legacy keys mirror INTO facets under their canonical key", () => {
    const cfg = parseConfig({
      rules: [
        {
          name: "client ui",
          from: {
            environment: "client",
            category: "ui",
            kind: "component",
            role: "react-component",
          },
          disallow: "b/**",
        },
      ],
    });
    const r = cfg.rules[0];
    if (r.type === "dependency") {
      // legacy typed arrays still populated (back-compat)
      expect(r.from.environments).toEqual(["client"]);
      expect(r.from.categories).toEqual(["ui"]);
      expect(r.from.kinds).toEqual(["component"]);
      expect(r.from.roles).toEqual(["react-component"]);
      // …and mirrored into facets under canonical keys
      expect(r.from.facets.env).toEqual(["client"]);
      expect(r.from.facets.category).toEqual(["ui"]);
      expect(r.from.facets.kind).toEqual(["component"]);
      expect(r.from.facets.role).toEqual(["react-component"]);
    }
  });

  test("legacy enum values are still validated pre-analysis", () => {
    expect(() =>
      parseConfig({ rules: [{ name: "x", from: { kind: "widget" }, disallow: "b/**" }] }),
    ).toThrow(/unknown value/);
  });

  test("a legacy field and a generic facets entry for the same key merge last-write-wins", () => {
    // Object key order is the document order parseSelector iterates: the later key
    // for the same canonical facet ("category") overwrites the earlier one.
    const facetsLast = parseConfig({
      rules: [
        {
          name: "x",
          from: { category: "ui", facets: { category: ["feature"] } },
          disallow: "b/**",
        },
      ],
    });
    const a = facetsLast.rules[0];
    if (a.type === "dependency") {
      expect(a.from.facets.category).toEqual(["feature"]); // facets came last → wins
      expect(a.from.categories).toEqual(["ui"]); // legacy typed array is untouched
    }

    const legacyLast = parseConfig({
      rules: [
        {
          name: "x",
          from: { facets: { category: ["feature"] }, category: "ui" },
          disallow: "b/**",
        },
      ],
    });
    const b = legacyLast.rules[0];
    if (b.type === "dependency") {
      expect(b.from.facets.category).toEqual(["ui"]); // legacy mirror came last → wins
    }
  });
});

describe("validation.unknownFacet severity (PRE-analysis parse)", () => {
  test("defaults to warning", () => {
    expect(parseConfig({}).validation.unknownFacet).toBe("warning");
    expect(parseConfig({ rules: [] }).validation.unknownFacet).toBe("warning");
  });

  test("can be set to error", () => {
    const cfg = parseConfig({ validation: { unknownFacet: "error" } });
    expect(cfg.validation.unknownFacet).toBe("error");
  });

  test("rejects a bad severity and unknown validation keys", () => {
    expect(() => parseConfig({ validation: { unknownFacet: "loud" } })).toThrow(ConfigError);
    expect(() => parseConfig({ validation: { nope: 1 } })).toThrow(/unknown/i);
  });
});

describe("POST-analysis: validateConfigAgainstIndex", () => {
  const index = indexWithRust();

  test("a known facet key + in-domain value is clean", () => {
    const cfg = parseConfig({
      rules: [
        { name: "ok", from: { facets: { "rust.visibility": ["pub", "crate"] } }, disallow: "b/**" },
      ],
    });
    expect(validateConfigAgainstIndex(cfg, index)).toEqual([]);
  });

  test("an unknown facet key is flagged at the configured severity (default warning)", () => {
    const cfg = parseConfig({
      rules: [{ name: "bad", from: { facets: { "go.exported": "true" } }, disallow: "b/**" }],
    });
    const problems = validateConfigAgainstIndex(cfg, index);
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe("warning");
    expect(problems[0].message).toMatch(/go\.exported/);
    expect(problems[0].where).toMatch(/rules\[0\]\.from/);
  });

  test("an out-of-domain value NOT present on any node is flagged", () => {
    const cfg = parseConfig({
      rules: [
        {
          name: "bad",
          from: { facets: { "rust.visibility": ["pub", "protected"] } },
          disallow: "b/**",
        },
      ],
    });
    // No node carries "protected" in `index`, so it is neither declared nor present.
    const problems = validateConfigAgainstIndex(cfg, index);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/protected/);
  });

  test("an undeclared-but-present closed value is admitted, not flagged", () => {
    // Spec §6: a value not in a closed descriptor's domain is still ADMITTED (data
    // not lost) and surfaced via present() with declared:false — the matcher would
    // match nodes carrying it, so the validator must not call it out-of-domain.
    const idx = indexWithUndeclaredVisibility();
    expect(idx.present("rust.visibility")).toContainEqual({ value: "protected", declared: false });
    const cfg = parseConfig({
      rules: [
        { name: "ok", from: { facets: { "rust.visibility": ["protected"] } }, disallow: "b/**" },
      ],
    });
    expect(validateConfigAgainstIndex(cfg, idx)).toEqual([]);
  });

  test("severity follows validation.unknownFacet", () => {
    const cfg = parseConfig({
      validation: { unknownFacet: "error" },
      rules: [{ name: "bad", from: { facets: { "go.exported": "true" } }, disallow: "b/**" }],
    });
    expect(validateConfigAgainstIndex(cfg, index)[0].severity).toBe("error");
  });

  test("legacy-mapped facets validate against the registry too", () => {
    // kind/env/category/role are structural-or-TS dimensions; with a Rust-only
    // catalog (no role/env/category descriptors) a legacy env selector is unknown.
    const cfg = parseConfig({
      rules: [{ name: "x", from: { environment: "client" }, disallow: "b/**" }],
    });
    const problems = validateConfigAgainstIndex(cfg, index);
    expect(problems.some((p) => p.message.includes("env"))).toBe(true);
  });

  test("open dimensions (folder/language) accept any value", () => {
    const cfg = parseConfig({
      rules: [
        { name: "x", from: { facets: { folder: "anything", language: "RS" } }, disallow: "b/**" },
      ],
    });
    expect(validateConfigAgainstIndex(cfg, index)).toEqual([]);
  });

  test("scope and cycle-rule selectors are validated", () => {
    const cfg = parseConfig({
      rules: [{ name: "c", cycles: "error", scope: { facets: { "go.exported": "true" } } }],
    });
    expect(validateConfigAgainstIndex(cfg, index)).toHaveLength(1);
  });
});
