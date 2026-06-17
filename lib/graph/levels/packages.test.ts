import { describe, expect, test } from "bun:test";
import { type GraphModel, type GraphNode, makeEdge } from "../types";
import {
  assignPackages,
  packageNameResolver,
  projectToPackages,
  projectToWorkspaces,
  ROOT_PACKAGE_ID,
} from "./packages";
import type { PackageManifest } from "./types";

const file = (filePath: string): GraphNode => ({
  id: filePath,
  kind: "file",
  label: filePath,
  filePath,
  line: 0,
  parentFile: filePath,
});

const react: GraphNode = {
  id: "external:react",
  kind: "external",
  label: "react",
  filePath: "",
  line: 0,
  parentFile: "external:react",
  externalKind: "npm",
};

const graph: GraphModel = {
  nodes: [
    file("crates/core/src/lib.rs"),
    file("crates/util/src/lib.rs"),
    file("src/index.ts"),
    react,
  ],
  edges: [
    makeEdge("crates/core/src/lib.rs", "crates/util/src/lib.rs", "call"),
    makeEdge("src/index.ts", "external:react", "import"),
  ],
};

const manifests: PackageManifest[] = [
  {
    id: "npm:root",
    name: "root",
    ecosystem: "npm",
    dir: "",
    manifestPath: "package.json",
    workspace: "root",
    declaredDeps: [],
  },
  {
    id: "cargo:core",
    name: "core",
    ecosystem: "cargo",
    dir: "crates/core",
    manifestPath: "crates/core/Cargo.toml",
    workspace: "rust-ws",
    declaredDeps: [{ name: "util" }],
  },
  {
    id: "cargo:util",
    name: "util",
    ecosystem: "cargo",
    dir: "crates/util",
    manifestPath: "crates/util/Cargo.toml",
    workspace: "rust-ws",
    declaredDeps: [],
  },
];

const PKG_CORE = "pkg:cargo:core";
const PKG_UTIL = "pkg:cargo:util";
const PKG_ROOT = "pkg:npm:root";
const PKG_REACT = "pkg:ext:react";

describe("assignPackages", () => {
  test("assigns each node to the nearest enclosing manifest", () => {
    const { packageOf } = assignPackages(graph, manifests);
    expect(packageOf.get("crates/core/src/lib.rs")).toBe(PKG_CORE);
    expect(packageOf.get("crates/util/src/lib.rs")).toBe(PKG_UTIL);
    expect(packageOf.get("src/index.ts")).toBe(PKG_ROOT);
    expect(packageOf.get("external:react")).toBe(PKG_REACT);
  });

  test("nodes outside any manifest fall into the root package", () => {
    const noRoot = manifests.filter((m) => m.dir !== "");
    const { packageOf } = assignPackages(graph, noRoot);
    expect(packageOf.get("src/index.ts")).toBe(ROOT_PACKAGE_ID);
  });
});

describe("projectToPackages", () => {
  const projected = projectToPackages(graph, manifests);
  const ids = projected.nodes.map((n) => n.id).sort();
  const edgeKeys = projected.edges.map((e) => `${e.source}->${e.target}`).sort();

  test("one node per package, including externals", () => {
    expect(ids).toEqual([PKG_REACT, PKG_CORE, PKG_ROOT, PKG_UTIL].sort());
  });

  test("cross-package base edges become package edges", () => {
    expect(edgeKeys).toContain(`${PKG_CORE}->${PKG_UTIL}`);
    expect(edgeKeys).toContain(`${PKG_ROOT}->${PKG_REACT}`);
  });

  test("answers 'which packages depend on util'", () => {
    const dependents = projected.edges.filter((e) => e.target === PKG_UTIL).map((e) => e.source);
    expect(dependents).toEqual([PKG_CORE]);
  });

  test("package nodes use the package name as label", () => {
    const core = projected.nodes.find((n) => n.id === PKG_CORE);
    expect(core?.label).toBe("core");
  });
});

describe("projectToWorkspaces", () => {
  const projected = projectToWorkspaces(graph, manifests);
  const ids = projected.nodes.map((n) => n.id).sort();

  test("packages collapse into their workspace, externals stay separate", () => {
    expect(ids).toEqual(["ws:root", "ws:rust-ws", PKG_REACT].sort());
  });

  test("intra-workspace edges drop; cross edges survive", () => {
    const keys = projected.edges.map((e) => `${e.source}->${e.target}`);
    expect(keys).not.toContain("ws:rust-ws->ws:rust-ws");
    expect(keys).toContain(`ws:root->${PKG_REACT}`);
  });
});

describe("packageNameResolver", () => {
  test("resolves a base node to its package name", () => {
    const resolve = packageNameResolver(graph, manifests);
    expect(resolve(file("crates/core/src/lib.rs"))).toBe("core");
    expect(resolve(file("src/index.ts"))).toBe("root");
  });
});
