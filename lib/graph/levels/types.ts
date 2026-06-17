// Abstraction levels for the graph: from the whole workspace down to individual symbols.
// Symbol/File/Directory are realised by the existing expand/collapse machinery; Package
// and Workspace are added by projecting the base graph through manifest-derived packages.

import type { DependencyType, ExternalKind } from "../types";

export type Level = "workspace" | "package" | "directory" | "file" | "symbol";

/** Coarse → fine, the order shown in the level switcher. */
export const LEVELS: readonly Level[] = ["workspace", "package", "directory", "file", "symbol"];

/** One declared dependency from a package manifest. */
export interface PackageDecl {
  name: string;
  version?: string;
  type?: DependencyType;
}

/** A package discovered from a manifest file (package.json, Cargo.toml, go.mod, …). */
export interface PackageManifest {
  /** Stable id, `${ecosystem}:${name}`. */
  id: string;
  name: string;
  /** "npm" | "cargo" | "go" | "python" | "maven" | "gradle" | … */
  ecosystem: string;
  /** Relative directory that owns the package ("" = repo root, no trailing slash). */
  dir: string;
  /** Relative path of the manifest file itself. */
  manifestPath: string;
  /** Owning workspace id, when the package is a member of one. */
  workspace?: string;
  declaredDeps: PackageDecl[];
}

/** A package node carries enough to render and to be matched by `package:` queries. */
export interface PackageMeta {
  ecosystem?: string;
  externalKind?: ExternalKind;
}
