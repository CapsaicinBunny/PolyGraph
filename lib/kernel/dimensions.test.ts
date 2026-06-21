import { describe, expect, test } from "bun:test";
import { buildDimensionIndex } from "../graph/dimension-index";
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
    // The merge's warning channel is surfaced on the result (not dropped at the
    // kernel boundary) and is empty for this conflict-free, namespaced merge.
    expect(result.catalogWarnings).toEqual([]);
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

// Phase E — per-language facets. The rust pack contributes namespaced facet
// dimensions; the native core attaches the per-node values and the kernel merge
// surfaces the descriptors in AnalyzeResult.dimensions (the catalog handshake).
describe("Phase E: rust pack facets", () => {
  const RUST = {
    "lib.rs": [
      "pub fn public_fn() {}",
      "fn private_fn() {}",
      "pub(crate) fn crate_fn() {}",
      "pub async fn fetch() {}",
      "pub unsafe fn danger() {}",
      "pub struct Widget;",
    ].join("\n"),
  };

  test("a Rust snippet yields GraphNode.facets['rust.visibility']", async () => {
    const { graph } = await analyzeProject(RUST);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    // `pub` items carry the explicit visibility facet (the model shape: strings).
    expect(byId.get("lib.rs#public_fn")?.facets?.["rust.visibility"]).toEqual(["pub"]);
    expect(byId.get("lib.rs#crate_fn")?.facets?.["rust.visibility"]).toEqual(["pub(crate)"]);
    expect(byId.get("lib.rs#Widget")?.facets?.["rust.visibility"]).toEqual(["pub"]);

    // Private items omit the facet entirely — `private` is the descriptor default,
    // never materialized per node (the "no low-information facets" rule).
    expect(byId.get("lib.rs#private_fn")?.facets?.["rust.visibility"]).toBeUndefined();

    // async / unsafe accumulate onto the same function node alongside visibility.
    expect(byId.get("lib.rs#fetch")?.facets).toEqual({
      "rust.visibility": ["pub"],
      "rust.async": ["async"],
    });
    expect(byId.get("lib.rs#danger")?.facets).toEqual({
      "rust.visibility": ["pub"],
      "rust.unsafe": ["unsafe"],
    });
  });

  test("the catalog contains a rust.visibility descriptor with labels + colors", async () => {
    const { dimensions } = await analyzeProject(RUST);
    const byKey = new Map((dimensions?.descriptors ?? []).map((d) => [d.key, d]));

    const vis = byKey.get("rust.visibility");
    expect(vis).toBeDefined();
    // Provider-contributed facet, namespaced, from the rust pack (the handshake).
    expect(vis?.dimension).toBe("facet");
    expect(vis?.providerIds).toEqual(["rust"]);
    expect(vis?.label).toBe("Visibility");
    expect(vis?.cardinality).toBe("single");
    expect(vis?.groupable).toBe(true);
    expect(vis?.defaultValue).toBe("private");

    // Every declared value carries a label AND a color (no UI hardcoding).
    expect(vis?.values.length).toBeGreaterThan(0);
    for (const v of vis?.values ?? []) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(vis?.values.find((v) => v.value === "pub")?.label).toBe("Public");
    expect(vis?.values.find((v) => v.value === "pub(crate)")?.color).toBe("#3b82f6");

    // async / unsafe descriptors come through too, also labelled + colored.
    expect(byKey.get("rust.async")?.label).toBe("Async");
    expect(byKey.get("rust.unsafe")?.label).toBe("Safety");
    expect(byKey.get("rust.async")?.values.find((v) => v.value === "async")?.color).toBe("#f59e0b");
  });

  test("the DimensionIndex projects rust.visibility, resolving absence to the default", async () => {
    const result = await analyzeProject(RUST);
    const index = buildDimensionIndex(result.graph, result.dimensions!);

    // private_fn has no stored facet → the index resolves it to the default.
    const priv = result.graph.nodes.find((n) => n.id === "lib.rs#private_fn")!;
    expect(index.valuesOfNode(priv, "rust.visibility")).toEqual(["private"]);
    const pub = result.graph.nodes.find((n) => n.id === "lib.rs#public_fn")!;
    expect(index.valuesOfNode(pub, "rust.visibility")).toEqual(["pub"]);

    // The default appears in present() (via the posting complement) and every
    // observed value is declared in the closed domain — no undeclared warnings.
    const present = index.present("rust.visibility").map((p) => p.value);
    expect(present).toContain("private");
    expect(present).toContain("pub");
    expect(index.warnings.filter((w) => w.key === "rust.visibility")).toEqual([]);
  });
});
