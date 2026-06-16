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

  test("npm subpath imports collapse to one node per package", () => {
    const { graph } = analyzeSources({
      "a.ts": `import { NextResponse } from "next/server"; import next from "next"; export const x = 1;`,
    });
    const externalIds = graph.nodes.filter((n) => n.kind === "external").map((n) => n.id);
    expect(externalIds).toContain("external:module:next");
    expect(externalIds).not.toContain("external:module:next/server");
  });

  test("npm externals are enriched with version + dependency type from package.json", () => {
    const { graph } = analyzeSources(
      { "a.ts": `import React from "react"; import L from "lodash"; export const x = 1;` },
      {
        packages: {
          react: { version: "^19.0.0", type: "dependency" },
          // lodash intentionally absent -> undeclared
        },
      },
    );
    const react = node(graph, "external:module:react");
    expect(react?.version).toBe("^19.0.0");
    expect(react?.dependencyType).toBe("dependency");
    expect(node(graph, "external:module:lodash")?.dependencyType).toBe("undeclared");
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
