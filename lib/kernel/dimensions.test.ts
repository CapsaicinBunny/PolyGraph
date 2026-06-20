import { describe, expect, test } from "bun:test";
import { analyzeProject } from "./index";

describe("kernel dimension catalog", () => {
  test("analyzeProject returns a merged dimensions catalog (structural + TS facets)", async () => {
    const result = await analyzeProject({
      // a client component (env=client, role=react-component, category=ui) …
      "App.tsx": `"use client";\nimport { readFileSync } from "node:fs";\nexport function App() { return <div/>; }`,
      // … and a plain feature.
      "util.ts": `export function add(a: number, b: number) { return a + b; }`,
    });

    expect(result.dimensions).toBeDefined();
    const keys = (result.dimensions?.descriptors ?? []).map((d) => d.key).sort();
    // Provider facets + the core structural dimensions, all present.
    expect(keys).toEqual(["category", "env", "folder", "kind", "language", "role", "runtime"]);
  });

  test("structural descriptors come from core; facet descriptors from typescript", async () => {
    const result = await analyzeProject({ "a.ts": "export function foo() {}\n" });
    const byKey = new Map((result.dimensions?.descriptors ?? []).map((d) => [d.key, d]));
    expect(byKey.get("kind")?.providerIds).toEqual(["core"]);
    expect(byKey.get("kind")?.dimension).toBe("structural");
    expect(byKey.get("role")?.providerIds).toEqual(["typescript"]);
    expect(byKey.get("role")?.dimension).toBe("facet");
  });
});
