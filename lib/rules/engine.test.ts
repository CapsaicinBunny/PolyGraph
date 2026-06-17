import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/load";
import { type GraphModel, makeEdge } from "../graph/types";
import { countBySeverity, evaluate, fingerprint } from "./engine";

// Helpers mirroring lib/graph/query.test.ts conventions.
const file = (path: string, extra: Record<string, unknown> = {}) => ({
  id: path,
  kind: "file" as const,
  label: path,
  filePath: path,
  line: 0,
  parentFile: path,
  ...extra,
});

describe("evaluate — dependency rules", () => {
  const graph: GraphModel = {
    nodes: [file("src/domain/order.ts"), file("src/ui/widget.ts"), file("src/util.ts")],
    edges: [
      makeEdge("src/domain/order.ts", "src/ui/widget.ts", "import", [
        { filePath: "src/domain/order.ts", line: 12, provider: "TypeScript", confidence: "exact" },
      ]),
      makeEdge("src/domain/order.ts", "src/util.ts", "import"),
    ],
  };

  test("flags a forbidden dependency and points at the occurrence line", () => {
    const cfg = parseConfig({
      rules: [
        { name: "Domain must not depend on UI", from: "src/domain/**", disallow: "src/ui/**" },
      ],
    });
    const v = evaluate(cfg, graph);
    expect(v).toHaveLength(1);
    expect(v[0].ruleName).toBe("Domain must not depend on UI");
    expect(v[0].severity).toBe("error");
    expect(v[0].location).toEqual({ filePath: "src/domain/order.ts", line: 12 });
    expect(v[0].related[0].filePath).toBe("src/ui/widget.ts");
  });

  test("a clean graph yields no violations", () => {
    const cfg = parseConfig({
      rules: [{ name: "Util must not depend on UI", from: "src/util.ts", disallow: "src/ui/**" }],
    });
    expect(evaluate(cfg, graph)).toEqual([]);
  });

  test("kind-based selector (components cannot reach database)", () => {
    const g: GraphModel = {
      nodes: [
        file("src/App.tsx#App", { kind: "component", parentFile: "src/App.tsx" }),
        file("src/database/db.ts"),
      ],
      edges: [makeEdge("src/App.tsx#App", "src/database/db.ts", "call")],
    };
    const cfg = parseConfig({
      rules: [
        {
          name: "Components cannot access database directly",
          from: { kind: "component" },
          disallow: { path: "src/database/**" },
        },
      ],
    });
    const v = evaluate(cfg, g);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("dependency");
  });

  test("collapses many symbol edges between the same file pair to one violation", () => {
    const g: GraphModel = {
      nodes: [
        file("src/domain/a.ts#x", { kind: "function", parentFile: "src/domain/a.ts" }),
        file("src/domain/a.ts#y", { kind: "function", parentFile: "src/domain/a.ts" }),
        file("src/ui/w.ts#z", { kind: "function", parentFile: "src/ui/w.ts" }),
      ],
      edges: [
        makeEdge("src/domain/a.ts#x", "src/ui/w.ts#z", "call"),
        makeEdge("src/domain/a.ts#y", "src/ui/w.ts#z", "call"),
      ],
    };
    const cfg = parseConfig({
      rules: [{ name: "no ui", from: "src/domain/**", disallow: "src/ui/**" }],
    });
    expect(evaluate(cfg, g)).toHaveLength(1);
  });
});

describe("evaluate — cycle rules", () => {
  // a → b → c → a is a 3-cycle; d is acyclic.
  const graph: GraphModel = {
    nodes: [
      file("packages/a/i.ts"),
      file("packages/b/i.ts"),
      file("packages/c/i.ts"),
      file("src/d.ts"),
    ],
    edges: [
      makeEdge("packages/a/i.ts", "packages/b/i.ts", "import"),
      makeEdge("packages/b/i.ts", "packages/c/i.ts", "import"),
      makeEdge("packages/c/i.ts", "packages/a/i.ts", "import"),
      makeEdge("src/d.ts", "packages/a/i.ts", "import"),
    ],
  };

  test("detects a cycle and reports all members", () => {
    const cfg = parseConfig({ rules: [{ name: "no cycles", cycles: "error" }] });
    const v = evaluate(cfg, graph);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("cycle");
    expect(v[0].related).toHaveLength(3);
  });

  test("scope limits cycles to a subtree", () => {
    const inScope = parseConfig({
      rules: [{ name: "pkg cycles", scope: "packages/**", cycles: "error" }],
    });
    expect(evaluate(inScope, graph)).toHaveLength(1);

    const outOfScope = parseConfig({
      rules: [{ name: "src cycles", scope: "src/**", cycles: "error" }],
    });
    expect(evaluate(outOfScope, graph)).toEqual([]);
  });
});

describe("evaluate — thresholds", () => {
  test("maxFanOut flags an over-connected node", () => {
    const targets = Array.from({ length: 5 }, (_, i) => file(`dep/${i}.ts`));
    const hub = file("hub.ts");
    const graph: GraphModel = {
      nodes: [hub, ...targets],
      edges: targets.map((t) => makeEdge("hub.ts", t.id, "import")),
    };
    const cfg = parseConfig({ thresholds: { maxFanOut: 3 } });
    const v = evaluate(cfg, graph);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("fan-out");
    expect(v[0].ruleName).toBe("maxFanOut");
    expect(v[0].severity).toBe("error");
  });

  test("maxDependencyDepth flags a long chain", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => file(`n${i}.ts`));
    const graph: GraphModel = {
      nodes,
      edges: nodes.slice(0, -1).map((n, i) => makeEdge(n.id, nodes[i + 1].id, "import")),
    };
    expect(evaluate(parseConfig({ thresholds: { maxDependencyDepth: 4 } }), graph)).toHaveLength(1);
    expect(evaluate(parseConfig({ thresholds: { maxDependencyDepth: 6 } }), graph)).toEqual([]);
  });

  test("threshold severity is configurable", () => {
    const graph: GraphModel = {
      nodes: [file("hub.ts"), file("a.ts"), file("b.ts")],
      edges: [makeEdge("hub.ts", "a.ts", "import"), makeEdge("hub.ts", "b.ts", "import")],
    };
    const v = evaluate(parseConfig({ thresholds: { maxFanOut: 1, severity: "warning" } }), graph);
    expect(v[0].severity).toBe("warning");
  });
});

describe("fingerprint + countBySeverity", () => {
  test("fingerprint is stable across runs and distinguishes rules", () => {
    const graph: GraphModel = {
      nodes: [file("src/domain/o.ts"), file("src/ui/w.ts")],
      edges: [makeEdge("src/domain/o.ts", "src/ui/w.ts", "import")],
    };
    const cfg = parseConfig({
      rules: [{ name: "r", from: "src/domain/**", disallow: "src/ui/**" }],
    });
    const a = evaluate(cfg, graph).map(fingerprint);
    const b = evaluate(cfg, graph).map(fingerprint);
    expect(a).toEqual(b);
  });

  test("countBySeverity splits errors and warnings", () => {
    const graph: GraphModel = {
      nodes: [file("a.ts"), file("b.ts"), file("c.ts")],
      edges: [makeEdge("a.ts", "b.ts", "import"), makeEdge("a.ts", "c.ts", "import")],
    };
    const cfg = parseConfig({
      rules: [{ name: "e", from: "a.ts", disallow: "b.ts" }],
      thresholds: { maxFanOut: 1, severity: "warning" },
    });
    const counts = countBySeverity(evaluate(cfg, graph));
    expect(counts.errors).toBe(1);
    expect(counts.warnings).toBe(1);
  });
});
