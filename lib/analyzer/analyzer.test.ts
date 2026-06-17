import { describe, expect, test } from "bun:test";
import type { GraphModel } from "../graph/types";
import { analyzeSources } from "./index";

function ids(graph: GraphModel) {
  return new Set(graph.nodes.map((n) => n.id));
}
function hasEdge(graph: GraphModel, source: string, target: string, kind: string): boolean {
  return graph.edges.some((e) => e.source === source && e.target === target && e.kind === kind);
}
function nodeKind(graph: GraphModel, id: string): string | undefined {
  return graph.nodes.find((n) => n.id === id)?.kind;
}

describe("declaration nodes", () => {
  test("collects file, class, interface, function, and component nodes", () => {
    const { graph } = analyzeSources({
      "src/util.ts": `
        export interface Shape { area(): number; }
        export class Circle implements Shape { area() { return 1; } }
        export function helper() { return 2; }
      `,
      "src/App.tsx": `
        export function App() { return <div>hi</div>; }
      `,
    });

    const nodeIds = ids(graph);
    expect(nodeIds.has("src/util.ts")).toBe(true);
    expect(nodeKind(graph, "src/util.ts")).toBe("file");
    expect(nodeKind(graph, "src/util.ts#Shape")).toBe("interface");
    expect(nodeKind(graph, "src/util.ts#Circle")).toBe("class");
    expect(nodeKind(graph, "src/util.ts#helper")).toBe("function");
    expect(nodeKind(graph, "src/App.tsx#App")).toBe("component");
  });

  test("classifies arrow function returning JSX as a component", () => {
    const { graph } = analyzeSources({
      "Button.tsx": `export const Button = () => <button>ok</button>;`,
      "math.ts": `export const add = (a: number, b: number) => a + b;`,
    });
    expect(nodeKind(graph, "Button.tsx#Button")).toBe("component");
    expect(nodeKind(graph, "math.ts#add")).toBe("function");
  });
});

describe("more declaration kinds", () => {
  test("collects type aliases, enums, and exported variables (skips internal consts)", () => {
    const { graph } = analyzeSources({
      "m.ts": `
        export type ID = string;
        export enum Color { Red, Green }
        export const TABLE = { a: 1 };
        const internalOnly = 5;
      `,
    });
    expect(nodeKind(graph, "m.ts#ID")).toBe("type");
    expect(nodeKind(graph, "m.ts#Color")).toBe("enum");
    expect(nodeKind(graph, "m.ts#TABLE")).toBe("variable");
    expect(graph.nodes.some((n) => n.id === "m.ts#internalOnly")).toBe(false);
  });
});

describe("import edges", () => {
  test("links files that import each other; external module is a distinct external node", () => {
    const { graph } = analyzeSources({
      "a.ts": `import { b } from "./b"; import React from "react"; export const a = () => b();`,
      "b.ts": `export function b() { return 1; }`,
    });
    expect(hasEdge(graph, "a.ts", "b.ts", "import")).toBe(true);
    // "react" resolves outside the project, so it becomes an external node (not a file).
    expect(nodeKind(graph, "external:module:react")).toBe("external");
    expect([...ids(graph)].some((id) => id === "react" || id === "react.ts")).toBe(false);
  });
});

describe("call edges (type-resolved)", () => {
  test("disambiguates two functions with the same name across files", () => {
    const { graph } = analyzeSources({
      "a.ts": `export function handle() { return 1; }`,
      "b.ts": `import { handle } from "./a"; export function caller() { handle(); }`,
      "c.ts": `function handle() { return 2; } export function localCaller() { handle(); }`,
    });

    // caller in b.ts must resolve to a.ts#handle, not c.ts#handle.
    expect(hasEdge(graph, "b.ts#caller", "a.ts#handle", "call")).toBe(true);
    expect(hasEdge(graph, "b.ts#caller", "c.ts#handle", "call")).toBe(false);

    // localCaller in c.ts must resolve to its own local handle.
    expect(hasEdge(graph, "c.ts#localCaller", "c.ts#handle", "call")).toBe(true);
    expect(hasEdge(graph, "c.ts#localCaller", "a.ts#handle", "call")).toBe(false);
  });

  test("method calls fold into the enclosing class node", () => {
    const { graph } = analyzeSources({
      "svc.ts": `
        export function log(msg: string) { return msg; }
        export class Service {
          run() { log("x"); }
        }
      `,
    });
    expect(hasEdge(graph, "svc.ts#Service", "svc.ts#log", "call")).toBe(true);
  });
});

describe("inheritance edges", () => {
  test("captures extends and implements", () => {
    const { graph } = analyzeSources({
      "shapes.ts": `
        export interface Drawable { draw(): void; }
        export class Base {}
        export class Square extends Base implements Drawable { draw() {} }
      `,
    });
    expect(hasEdge(graph, "shapes.ts#Square", "shapes.ts#Base", "extends")).toBe(true);
    expect(hasEdge(graph, "shapes.ts#Square", "shapes.ts#Drawable", "implements")).toBe(true);
  });

  test("captures interface extends across files", () => {
    const { graph } = analyzeSources({
      "base.ts": `export interface A { x: number; }`,
      "child.ts": `import { A } from "./base"; export interface B extends A { y: number; }`,
    });
    expect(hasEdge(graph, "child.ts#B", "base.ts#A", "extends")).toBe(true);
  });
});

describe("component render edges", () => {
  test("links a component to the components it renders and skips html tags", () => {
    const { graph } = analyzeSources({
      "Child.tsx": `export function Child() { return <span>c</span>; }`,
      "Parent.tsx": `
        import { Child } from "./Child";
        export function Parent() { return <div><Child /></div>; }
      `,
    });
    expect(hasEdge(graph, "Parent.tsx#Parent", "Child.tsx#Child", "renders")).toBe(true);
    // No edge for the intrinsic <div>/<span>.
    expect(graph.edges.filter((e) => e.kind === "renders").length).toBe(1);
  });
});

describe("robustness", () => {
  test("empty input yields an empty graph and no errors", () => {
    const { graph, errors, unresolved } = analyzeSources({});
    expect(graph.nodes.length).toBe(0);
    expect(graph.edges.length).toBe(0);
    expect(errors.length).toBe(0);
    expect(unresolved.length).toBe(0);
  });
});

describe("unresolved imports", () => {
  test("reports a relative import that resolves to no file in the set", () => {
    const { unresolved } = analyzeSources({
      "src/a.ts": `import { thing } from "./missing";\nexport const x = 1;`,
    });
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      sourceId: "src/a.ts",
      name: "./missing",
      filePath: "src/a.ts",
      line: 1,
    });
  });

  test("does not report bare specifiers (externals) or resolved relative imports", () => {
    const { unresolved } = analyzeSources({
      "src/a.ts": `import { useState } from "react";\nimport { b } from "./b";\nexport const x = b;`,
      "src/b.ts": `export const b = 1;`,
    });
    expect(unresolved).toHaveLength(0);
  });
});
