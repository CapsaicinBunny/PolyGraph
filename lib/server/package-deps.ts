import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DependencyType } from "../graph/types";

export interface PackageDep {
  version: string;
  type: DependencyType;
}

/** Map of package name -> declared version + dependency kind, from package.json. */
export type PackageDeps = Record<string, PackageDep>;

/** Read and flatten a project's package.json dependency sections. Returns {} if absent. */
export async function readPackageDeps(root: string): Promise<PackageDeps> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }

  const deps: PackageDeps = {};
  const add = (section: unknown, type: DependencyType) => {
    if (!section || typeof section !== "object") return;
    for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
      deps[name] = { version: String(version), type };
    }
  };
  // Order matters least-to-most specific isn't a concern; a name appears in one section.
  add(pkg.dependencies, "dependency");
  add(pkg.devDependencies, "devDependency");
  add(pkg.peerDependencies, "peerDependency");
  add(pkg.optionalDependencies, "optionalDependency");
  return deps;
}
