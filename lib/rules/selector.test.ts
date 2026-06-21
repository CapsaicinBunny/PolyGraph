// Phase D — generic facet matching in the rules selector.
//
// `matchNode` matches a node against a normalized NodeSelector's generic `facets`
// store (keyed by canonical dimension key). Facet keys are AND-ed; values within a
// key OR-ed; an empty selector facet is ignored. Structural keys (kind/folder/
// language) resolve from the node; facet keys resolve from `node.facets` (with a
// legacy-field/default fallback so legacy-only nodes still match).

import { describe, expect, test } from "bun:test";
import { writeFacet } from "../graph/facets-write";
import type { GraphNode } from "../graph/types";
import type { NodeSelector } from "../config/schema";
import { matchNode } from "./selector";

const EMPTY: NodeSelector = {
  paths: [],
  kinds: [],
  roles: [],
  environments: [],
  categories: [],
  facets: {},
};

function sel(overrides: Partial<NodeSelector>): NodeSelector {
  return { ...EMPTY, ...overrides };
}

function node(extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "crate/a.rs#A",
    kind: "struct",
    label: "A",
    filePath: "crate/a.rs",
    line: 1,
    parentFile: "crate/a.rs",
    ...extra,
  };
}

describe("matchNode — generic facets", () => {
  test("matches a provider facet stored on node.facets", () => {
    const n = node();
    writeFacet(n, "rust.visibility", ["pub"]);
    expect(matchNode(sel({ facets: { "rust.visibility": ["pub"] } }), n)).toBe(true);
    expect(matchNode(sel({ facets: { "rust.visibility": ["private"] } }), n)).toBe(false);
  });

  test("values within a facet key are OR-ed", () => {
    const n = node();
    writeFacet(n, "rust.visibility", ["crate"]);
    expect(matchNode(sel({ facets: { "rust.visibility": ["pub", "crate"] } }), n)).toBe(true);
  });

  test("distinct facet keys are AND-ed", () => {
    const n = node({ kind: "component", filePath: "app/page.tsx" });
    writeFacet(n, "role", ["react-component"]);
    // kind via structural resolution + role via facets — both must hold.
    expect(matchNode(sel({ facets: { kind: ["component"], role: ["react-component"] } }), n)).toBe(
      true,
    );
    expect(matchNode(sel({ facets: { kind: ["function"], role: ["react-component"] } }), n)).toBe(
      false,
    );
  });

  test("structural kind facet resolves from node.kind", () => {
    expect(matchNode(sel({ facets: { kind: ["struct"] } }), node())).toBe(true);
    expect(matchNode(sel({ facets: { kind: ["class"] } }), node())).toBe(false);
  });

  test("structural folder + language facets resolve from filePath", () => {
    const n = node({ filePath: "src/api/users.ts" });
    expect(matchNode(sel({ facets: { folder: ["src"] } }), n)).toBe(true);
    expect(matchNode(sel({ facets: { language: ["TS"] } }), n)).toBe(true);
    expect(matchNode(sel({ facets: { language: ["RS"] } }), n)).toBe(false);
  });

  test("language facet accepts human names (aliases), like the query language", () => {
    const rs = node({ filePath: "crate/a.rs" });
    // Human name → badge code, consistent with `language:rust` in the query language.
    expect(matchNode(sel({ facets: { language: ["rust"] } }), rs)).toBe(true);
    expect(matchNode(sel({ facets: { language: ["RS"] } }), rs)).toBe(true);
    expect(matchNode(sel({ facets: { language: ["typescript"] } }), rs)).toBe(false);

    const ts = node({ filePath: "src/api/users.ts" });
    expect(matchNode(sel({ facets: { language: ["typescript"] } }), ts)).toBe(true);
    // Mixed name + code in one OR-list both resolve to the badge-code space.
    expect(matchNode(sel({ facets: { language: ["rust", "TS"] } }), ts)).toBe(true);
  });

  test("category default (feature) matches a node with no explicit category", () => {
    expect(matchNode(sel({ facets: { category: ["feature"] } }), node())).toBe(true);
    expect(matchNode(sel({ facets: { category: ["ui"] } }), node())).toBe(false);
  });

  test("legacy-only node (facets unset) still matches via legacy field fallback", () => {
    const n = node({ role: "react-component", environment: "client" });
    expect(matchNode(sel({ facets: { role: ["react-component"] } }), n)).toBe(true);
    expect(matchNode(sel({ facets: { env: ["client"] } }), n)).toBe(true);
    expect(matchNode(sel({ facets: { env: ["server"] } }), n)).toBe(false);
  });

  test("paths AND with facets", () => {
    const n = node({ filePath: "crate/a.rs" });
    writeFacet(n, "rust.visibility", ["pub"]);
    expect(matchNode(sel({ paths: ["crate/**"], facets: { "rust.visibility": ["pub"] } }), n)).toBe(
      true,
    );
    expect(matchNode(sel({ paths: ["other/**"], facets: { "rust.visibility": ["pub"] } }), n)).toBe(
      false,
    );
  });

  test("an empty facets store places no constraint", () => {
    expect(matchNode(sel({ paths: ["crate/**"] }), node())).toBe(true);
  });

  test("a facet key with an empty value array is ignored", () => {
    expect(matchNode(sel({ facets: { "rust.visibility": [] } }), node())).toBe(true);
  });
});
