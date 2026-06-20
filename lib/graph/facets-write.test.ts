import { expect, test } from "bun:test";
import { FACET_DEFAULTS, facetParityMismatches, writeFacet } from "./facets-write";
import type { GraphNode } from "./types";

function bareNode(): GraphNode {
  return { id: "a.ts", kind: "file", label: "a.ts", filePath: "a.ts", line: 0, parentFile: "a.ts" };
}

test("writeFacet sets BOTH the legacy field and node.facets for an informative value", () => {
  const node = bareNode();
  writeFacet(node, "category", ["ui"]);
  expect(node.category).toBe("ui");
  expect(node.facets?.category).toEqual(["ui"]);
});

test("writeFacet sets the legacy field but NOT node.facets for the default value", () => {
  const node = bareNode();
  writeFacet(node, "category", ["feature"]);
  // Legacy field is always mirrored…
  expect(node.category).toBe("feature");
  // …but the ubiquitous default is never materialized as a facet.
  expect(node.facets?.category).toBeUndefined();
  expect(FACET_DEFAULTS.category).toBe("feature");
});

test("writeFacet mirrors env → environment and role → role", () => {
  const node = bareNode();
  writeFacet(node, "env", ["client"]);
  writeFacet(node, "role", ["react-component"]);
  expect(node.environment).toBe("client");
  expect(node.facets?.env).toEqual(["client"]);
  expect(node.role).toBe("react-component");
  expect(node.facets?.role).toEqual(["react-component"]);
});

test("writeFacet handles a multi-valued runtime → runtimes array", () => {
  const node = bareNode();
  writeFacet(node, "runtime", ["node", "bun"]);
  expect(node.runtimes).toEqual(["node", "bun"]);
  expect(node.facets?.runtime).toEqual(["node", "bun"]);
});

test("writeFacet with empty values is a no-op (no legacy, no facet)", () => {
  const node = bareNode();
  writeFacet(node, "env", []);
  expect(node.environment).toBeUndefined();
  expect(node.facets).toBeUndefined();
});

test("facetParityMismatches is empty when legacy and facets agree across all keys", () => {
  const node = bareNode();
  writeFacet(node, "category", ["ui"]);
  writeFacet(node, "role", ["ecs-system"]);
  writeFacet(node, "env", ["server"]);
  writeFacet(node, "runtime", ["deno"]);
  expect(facetParityMismatches(node)).toEqual([]);
});

test("facetParityMismatches is empty for the unmaterialized category default", () => {
  // category "feature" is mirrored to the legacy field but never stored as a facet;
  // parity still holds because absence resolves to the default.
  const node = bareNode();
  writeFacet(node, "category", ["feature"]);
  expect(node.facets?.category).toBeUndefined();
  expect(facetParityMismatches(node)).toEqual([]);
});

test("facetParityMismatches is empty for a bare node (category absent ⇒ feature)", () => {
  expect(facetParityMismatches(bareNode())).toEqual([]);
});

test("facetParityMismatches detects a deliberately desynced facet", () => {
  const node = bareNode();
  node.environment = "client";
  node.facets = { env: ["server"] };
  expect(facetParityMismatches(node)).toContain("env");
});
