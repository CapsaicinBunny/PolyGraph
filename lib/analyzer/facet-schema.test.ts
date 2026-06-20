import { expect, test } from "bun:test";
import { ROLE_STYLES } from "../graph/visual";
import { TS_FACET_DESCRIPTORS } from "./facet-schema";

function descriptor(key: string) {
  return TS_FACET_DESCRIPTORS.find((d) => d.key === key);
}

test("TS_FACET_DESCRIPTORS covers role, category, env, runtime — all from typescript", () => {
  expect(TS_FACET_DESCRIPTORS.map((d) => d.key).sort()).toEqual([
    "category",
    "env",
    "role",
    "runtime",
  ]);
  for (const d of TS_FACET_DESCRIPTORS) {
    expect(d.dimension).toBe("facet");
    expect(d.domain).toBe("closed");
    expect(d.providerIds).toEqual(["typescript"]);
    expect(d.filterable).toBe(true);
    expect(d.missing).toEqual({ filter: "include", group: "unclassified" });
    expect(d.label.length).toBeGreaterThan(0);
  }
});

test("role: closed, single, every NodeRole with labels+colors from ROLE_STYLES", () => {
  const role = descriptor("role");
  expect(role?.cardinality).toBe("single");
  expect(role?.grouping).toEqual({ mode: "single" });
  expect(role?.groupable).toBe(true);

  const roleKeys = Object.keys(ROLE_STYLES);
  expect(role?.values.map((v) => v.value).sort()).toEqual([...roleKeys].sort());
  // Each value's label + color mirrors ROLE_STYLES exactly.
  for (const v of role?.values ?? []) {
    expect(v.label).toBe(ROLE_STYLES[v.value as keyof typeof ROLE_STYLES].label);
    expect(v.color).toBe(ROLE_STYLES[v.value as keyof typeof ROLE_STYLES].color);
  }
});

test("category: closed/single, defaultValue feature, ui/feature with the spec colors", () => {
  const cat = descriptor("category");
  expect(cat?.cardinality).toBe("single");
  expect(cat?.defaultValue).toBe("feature");
  expect(cat?.grouping).toEqual({ mode: "single" });
  expect(cat?.groupable).toBe(true);
  expect(cat?.values.find((v) => v.value === "ui")?.color).toBe("#22c55e");
  expect(cat?.values.find((v) => v.value === "feature")?.color).toBe("#3b82f6");
});

test("env: closed/single, client/server with the spec colors", () => {
  const env = descriptor("env");
  expect(env?.cardinality).toBe("single");
  expect(env?.grouping).toEqual({ mode: "single" });
  expect(env?.groupable).toBe(true);
  expect(env?.values.find((v) => v.value === "client")?.color).toBe("#fb923c");
  expect(env?.values.find((v) => v.value === "server")?.color).toBe("#2dd4bf");
});

test("runtime: closed/multi, grouping disabled + not groupable, node/deno/bun colors", () => {
  const rt = descriptor("runtime");
  expect(rt?.cardinality).toBe("multi");
  expect(rt?.grouping).toEqual({ mode: "disabled" });
  expect(rt?.groupable).toBe(false);
  expect(rt?.values.find((v) => v.value === "node")?.color).toBe("#4ade80");
  expect(rt?.values.find((v) => v.value === "deno")?.color).toBe("#60a5fa");
  expect(rt?.values.find((v) => v.value === "bun")?.color).toBe("#f472b6");
});
