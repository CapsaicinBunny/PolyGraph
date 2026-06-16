import { describe, expect, test } from "bun:test";
import type { GraphModel } from "../graph/types";
import { analyzeSources } from "./index";

function node(g: GraphModel, id: string) {
  return g.nodes.find((n) => n.id === id);
}

describe("file facets", () => {
  test('"use client" directive marks the environment as client', () => {
    const { graph } = analyzeSources({
      "C.tsx": `"use client";\nexport function C() { return <div/>; }`,
    });
    expect(node(graph, "C.tsx#C")?.environment).toBe("client");
    expect(node(graph, "C.tsx")?.environment).toBe("client");
  });

  test('"use server" directive marks the environment as server', () => {
    const { graph } = analyzeSources({
      "a.ts": `"use server";\nexport function action() { return 1; }`,
    });
    expect(node(graph, "a.ts#action")?.environment).toBe("server");
  });

  test("detects the node runtime from a builtin import and globals", () => {
    const { graph } = analyzeSources({
      "s.ts": `import { readFileSync } from "node:fs"; export function read() { return process.cwd(); }`,
    });
    expect(node(graph, "s.ts")?.runtimes).toContain("node");
  });

  test("detects bun and deno from their globals", () => {
    const { graph } = analyzeSources({
      "b.ts": `export function serve() { return Bun.serve({}); }`,
      "d.ts": `export function read() { return Deno.readTextFileSync("x"); }`,
    });
    expect(node(graph, "b.ts")?.runtimes).toContain("bun");
    expect(node(graph, "d.ts")?.runtimes).toContain("deno");
  });

  test("a property named `process` is not mistaken for the node runtime", () => {
    const { graph } = analyzeSources({
      "ok.ts": `export function f(o: { process: number }) { return o.process; }`,
    });
    expect(node(graph, "ok.ts")?.runtimes ?? []).not.toContain("node");
  });

  test("category: a component is UI, a plain function is a feature", () => {
    const { graph } = analyzeSources({
      "App.tsx": `export function App() { return <div/>; }`,
      "util.ts": `export function add(a: number, b: number) { return a + b; }`,
    });
    expect(node(graph, "App.tsx#App")?.category).toBe("ui");
    expect(node(graph, "util.ts#add")?.category).toBe("feature");
  });
});
