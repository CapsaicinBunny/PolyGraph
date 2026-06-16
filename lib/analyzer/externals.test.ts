import { describe, expect, test } from "bun:test";
import type { GraphModel } from "../graph/types";
import { analyzeSources } from "./index";

function node(g: GraphModel, id: string) {
  return g.nodes.find((n) => n.id === id);
}
function hasEdge(g: GraphModel, source: string, target: string, kind: string): boolean {
  return g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);
}

describe("external nodes", () => {
  test("imported packages become external nodes classified by family", () => {
    const { graph } = analyzeSources({
      "a.ts": `import React from "react"; import { readFile } from "node:fs"; export const x = 1;`,
    });
    const npm = node(graph, "external:module:react");
    const builtin = node(graph, "external:module:node:fs");
    expect(npm?.kind).toBe("external");
    expect(npm?.externalKind).toBe("npm");
    expect(builtin?.externalKind).toBe("node");
    expect(hasEdge(graph, "a.ts", "external:module:react", "import")).toBe(true);
    expect(hasEdge(graph, "a.ts", "external:module:node:fs", "import")).toBe(true);
  });

  test("relative imports stay internal (no external node)", () => {
    const { graph } = analyzeSources({
      "a.ts": `import { b } from "./b"; export const a = () => b();`,
      "b.ts": `export function b() { return 1; }`,
    });
    expect(graph.nodes.some((n) => n.kind === "external")).toBe(false);
  });

  test("Bun / Deno / process API usage becomes external API nodes", () => {
    const { graph } = analyzeSources({
      "b.ts": `export function serve() { return Bun.serve({}); }`,
      "d.ts": `export function read() { return Deno.readTextFileSync("x"); }`,
      "p.ts": `export function cwd() { return process.cwd(); }`,
    });
    expect(node(graph, "external:api:Bun.serve")?.externalKind).toBe("bun");
    expect(node(graph, "external:api:Deno.readTextFileSync")?.externalKind).toBe("deno");
    expect(node(graph, "external:api:process.cwd")?.externalKind).toBe("node");
    expect(hasEdge(graph, "b.ts#serve", "external:api:Bun.serve", "call")).toBe(true);
    expect(hasEdge(graph, "d.ts#read", "external:api:Deno.readTextFileSync", "call")).toBe(true);
  });
});
