import { describe, expect, test } from "bun:test";
import { ConfigError } from "./schema";
import { parseConfig } from "./load";

describe("parseConfig", () => {
  test("parses the documented example shape", () => {
    const cfg = parseConfig({
      rules: [
        { name: "Domain must not depend on UI", from: "src/domain/**", disallow: ["src/ui/**"] },
        { name: "No circular package dependencies", scope: "packages/**", cycles: "error" },
        {
          name: "Components cannot access database directly",
          from: { kind: "component" },
          disallow: { path: "src/database/**" },
        },
      ],
      thresholds: { maxFanOut: 25, maxDependencyDepth: 12 },
    });

    expect(cfg.rules).toHaveLength(3);

    const dep = cfg.rules[0];
    expect(dep.type).toBe("dependency");
    if (dep.type === "dependency") {
      expect(dep.from.paths).toEqual(["src/domain/**"]);
      expect(dep.disallow.paths).toEqual(["src/ui/**"]);
      expect(dep.severity).toBe("error"); // dependency rules default to error
    }

    const cycle = cfg.rules[1];
    expect(cycle.type).toBe("cycle");
    if (cycle.type === "cycle") {
      expect(cycle.severity).toBe("error");
      expect(cycle.scope?.paths).toEqual(["packages/**"]);
    }

    const comp = cfg.rules[2];
    if (comp.type === "dependency") {
      expect(comp.from.kinds).toEqual(["component"]);
      expect(comp.disallow.paths).toEqual(["src/database/**"]);
    }

    expect(cfg.thresholds.maxFanOut).toBe(25);
    expect(cfg.thresholds.maxDependencyDepth).toBe(12);
    expect(cfg.thresholds.severity).toBe("error");
  });

  test("empty / null doc yields no rules", () => {
    expect(parseConfig(null).rules).toEqual([]);
    expect(parseConfig({}).rules).toEqual([]);
  });

  test("cycles: warning sets severity", () => {
    const cfg = parseConfig({ rules: [{ name: "c", cycles: "warning" }] });
    expect(cfg.rules[0].severity).toBe("warning");
  });

  test("dependency severity override", () => {
    const cfg = parseConfig({
      rules: [{ name: "soft", from: "a/**", disallow: "b/**", severity: "warning" }],
    });
    expect(cfg.rules[0].severity).toBe("warning");
  });

  test("rejects a rule missing both cycles and from/disallow", () => {
    expect(() => parseConfig({ rules: [{ name: "x", from: "a/**" }] })).toThrow(ConfigError);
  });

  test("rejects a rule with no name", () => {
    expect(() => parseConfig({ rules: [{ from: "a/**", disallow: "b/**" }] })).toThrow(/name/);
  });

  test("rejects an empty selector", () => {
    expect(() => parseConfig({ rules: [{ name: "x", from: {}, disallow: "b/**" }] })).toThrow(
      /matches nothing/,
    );
  });

  test("rejects unknown kind", () => {
    expect(() =>
      parseConfig({ rules: [{ name: "x", from: { kind: "widget" }, disallow: "b/**" }] }),
    ).toThrow(/unknown value/);
  });

  test("rejects unknown top-level and selector fields", () => {
    expect(() => parseConfig({ nope: 1 })).toThrow(/Unknown top-level field/);
    expect(() =>
      parseConfig({ rules: [{ name: "x", from: { kindz: "class" }, disallow: "b/**" }] }),
    ).toThrow(/unknown selector field/);
  });

  test("rejects negative / non-number thresholds", () => {
    expect(() => parseConfig({ thresholds: { maxFanOut: -1 } })).toThrow(ConfigError);
    expect(() => parseConfig({ thresholds: { maxFanOut: "lots" } })).toThrow(ConfigError);
  });

  test("multi-facet selector AND-s facets", () => {
    const cfg = parseConfig({
      rules: [
        {
          name: "client ui cannot import server",
          from: { environment: "client", category: "ui" },
          disallow: { environment: "server" },
        },
      ],
    });
    const r = cfg.rules[0];
    if (r.type === "dependency") {
      expect(r.from.environments).toEqual(["client"]);
      expect(r.from.categories).toEqual(["ui"]);
      expect(r.disallow.environments).toEqual(["server"]);
    }
  });
});
