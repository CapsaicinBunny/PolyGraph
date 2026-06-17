import { describe, expect, test } from "bun:test";
import type { GraphEdge, GraphModel } from "../graph/types";
import { analyzeSources } from "./index";

const findEdge = (g: GraphModel, p: (e: GraphEdge) => boolean) => g.edges.find(p);

describe("edge evidence capture (TypeScript provider)", () => {
  test("a call edge carries exact TypeScript evidence with a location", () => {
    const { graph } = analyzeSources({
      "src/a.ts":
        "export function loadUser() {\n  return 1;\n}\nexport function run() {\n  return loadUser();\n}\n",
    });
    const e = findEdge(graph, (x) => x.kind === "call" && x.target === "src/a.ts#loadUser");
    expect(e).toBeTruthy();
    expect(e?.count).toBe(1);
    expect(e?.occurrences.length).toBe(1);
    const ev = e?.occurrences[0];
    expect(ev?.filePath).toBe("src/a.ts");
    expect(ev?.provider).toBe("TypeScript");
    expect(ev?.confidence).toBe("exact");
    expect(ev?.line).toBe(5); // the `loadUser()` call line
  });

  test("two call sites accumulate into one edge with count 2", () => {
    const { graph } = analyzeSources({
      "src/a.ts":
        "export function loadUser() {\n  return 1;\n}\nexport function run() {\n  loadUser();\n  return loadUser();\n}\n",
    });
    const e = findEdge(
      graph,
      (x) => x.kind === "call" && x.source === "src/a.ts#run" && x.target === "src/a.ts#loadUser",
    );
    expect(e?.count).toBe(2);
    expect(e?.occurrences.length).toBe(2);
  });

  test("a third-party import edge is inferred", () => {
    const { graph } = analyzeSources({
      "src/a.ts": 'import { useState } from "react";\nexport const x = useState;\n',
    });
    const e = findEdge(
      graph,
      (x) => x.kind === "import" && x.target.startsWith("external:module:"),
    );
    expect(e).toBeTruthy();
    expect(e?.occurrences[0]?.confidence).toBe("inferred");
    expect(e?.occurrences[0]?.provider).toBe("TypeScript");
  });
});
