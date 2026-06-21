import { describe, expect, test } from "bun:test";
import { facetParityMismatches } from "../graph/facets-write";
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

  test("identifiers colliding with Object.prototype keys are not mistaken for runtimes", () => {
    // Regression: the runtime table was a plain object, so `TABLE[id.getText()]` for a
    // value-position identifier named `toString`/`valueOf`/`constructor`/… resolved an
    // inherited Object.prototype *function* (truthy) and stored it as a bogus runtime.
    // In memory that's a function; JSON.stringify turns it into `null` across the wire,
    // which then crashed value-keyed styling. Generated glue (wasm-bindgen) is full of
    // such identifiers. Every runtime must be a real Runtime string, never a function.
    const { graph } = analyzeSources({
      "glue.ts": `export function g() {
        return [toString, valueOf, constructor, hasOwnProperty, isPrototypeOf, propertyIsEnumerable];
      }`,
    });
    const runtimes = node(graph, "glue.ts")?.runtimes ?? [];
    expect(runtimes).toEqual([]);
    expect(runtimes.every((r) => typeof r === "string")).toBe(true);
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

describe("dual-write parity invariant (graph-wide)", () => {
  // The spec's non-negotiable: legacy typed fields ≡ facets-or-default for EVERY
  // node the real analyzer produces, throughout Phases A–C. A future regression in
  // node production (a code path that sets node.role/category/env/runtimes directly
  // instead of via writeFacet) would desync exactly one of the two and fail here.
  test("every analyzer-produced node has legacy fields in lock-step with its facets", () => {
    const { graph } = analyzeSources({
      // client component: env=client, role=react-component, category=ui
      "App.tsx": `"use client";\nimport { useState } from "react";\nexport function App() { const [n] = useState(0); return <div>{n}</div>; }`,
      // server action: env=server
      "action.ts": `"use server";\nexport async function save() { return 1; }`,
      // node runtime (builtin import + process global)
      "fs.ts": `import { readFileSync } from "node:fs";\nexport function read() { return readFileSync(process.cwd()); }`,
      // bun + deno runtimes via globals
      "bun.ts": `export function serve() { return Bun.serve({}); }`,
      "deno.ts": `export function read() { return Deno.readTextFileSync("x"); }`,
      // ECS role
      "ecs.ts": `export class MovementSystem { update() {} }`,
      // Vue component role
      "Widget.vue.ts": `export default { name: "Widget", template: "<div/>" };`,
      // plain feature (category default — never materialized as a facet)
      "util.ts": `export function add(a: number, b: number) { return a + b; }`,
    });

    expect(graph.nodes.length).toBeGreaterThan(0);
    const offenders = graph.nodes
      .map((n) => ({ id: n.id, mismatches: facetParityMismatches(n) }))
      .filter((x) => x.mismatches.length > 0);
    expect(offenders).toEqual([]);
  });
});
