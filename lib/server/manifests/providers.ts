// Per-ecosystem manifest parsers. Each turns one manifest file into a PackageManifest.
// Workspace membership is resolved later by the registry (see index.ts).

import type { DependencyType } from "../../graph/types";
import type { PackageDecl, PackageManifest } from "../../graph/levels/types";
import { parseToml, type TomlTable } from "./toml";

export interface ParsedManifest {
  manifest: PackageManifest;
  /** True when this manifest declares a workspace (its dir becomes a workspace root). */
  isWorkspaceRoot: boolean;
}

export interface ManifestProvider {
  ecosystem: string;
  matches(path: string): boolean;
  parse(path: string, content: string): ParsedManifest | null;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}
function dirOf(path: string): string {
  const norm = normalize(path);
  const i = norm.lastIndexOf("/");
  return i === -1 ? "" : norm.slice(0, i);
}
function baseName(path: string): string {
  const norm = normalize(path);
  return norm.slice(norm.lastIndexOf("/") + 1);
}
function lastSegment(dir: string): string {
  return dir === "" ? "root" : dir.slice(dir.lastIndexOf("/") + 1);
}
function asTable(v: unknown): TomlTable | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as TomlTable) : undefined;
}

// ---- npm / package.json ----------------------------------------------------

const npm: ManifestProvider = {
  ecosystem: "npm",
  matches: (path) => baseName(path) === "package.json",
  parse(path, content) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(content);
    } catch {
      return null;
    }
    const dir = dirOf(path);
    const name = typeof pkg.name === "string" ? pkg.name : lastSegment(dir);
    const declaredDeps: PackageDecl[] = [];
    const add = (section: unknown, type: DependencyType) => {
      const t = asTable(section);
      if (!t) return;
      for (const [n, v] of Object.entries(t)) {
        declaredDeps.push({ name: n, version: typeof v === "string" ? v : undefined, type });
      }
    };
    add(pkg.dependencies, "dependency");
    add(pkg.devDependencies, "devDependency");
    add(pkg.peerDependencies, "peerDependency");
    add(pkg.optionalDependencies, "optionalDependency");
    return {
      manifest: {
        id: `npm:${name}`,
        name,
        ecosystem: "npm",
        dir,
        manifestPath: normalize(path),
        declaredDeps,
      },
      isWorkspaceRoot: pkg.workspaces !== undefined,
    };
  },
};

// ---- Cargo / Cargo.toml -----------------------------------------------------

const cargo: ManifestProvider = {
  ecosystem: "cargo",
  matches: (path) => baseName(path) === "Cargo.toml",
  parse(path, content) {
    const toml = parseToml(content);
    const dir = dirOf(path);
    const pkgTable = asTable(toml.package);
    const isWorkspaceRoot = asTable(toml.workspace) !== undefined;
    if (!pkgTable && !isWorkspaceRoot) return null;
    const name = typeof pkgTable?.name === "string" ? pkgTable.name : lastSegment(dir);
    const declaredDeps: PackageDecl[] = [];
    const deps = asTable(toml.dependencies);
    if (deps) {
      for (const [n, v] of Object.entries(deps)) {
        const version = typeof v === "string" ? v : (asTable(v)?.version as string | undefined);
        declaredDeps.push({ name: n, version, type: "dependency" });
      }
    }
    return {
      manifest: {
        id: `cargo:${name}`,
        name,
        ecosystem: "cargo",
        dir,
        manifestPath: normalize(path),
        declaredDeps,
      },
      isWorkspaceRoot,
    };
  },
};

// ---- Go / go.mod ------------------------------------------------------------

const go: ManifestProvider = {
  ecosystem: "go",
  matches: (path) => baseName(path) === "go.mod",
  parse(path, content) {
    const dir = dirOf(path);
    const lines = content.split(/\r?\n/);
    let module = lastSegment(dir);
    const declaredDeps: PackageDecl[] = [];
    let inRequire = false;
    for (const raw of lines) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (line === "") continue;
      const mod = line.match(/^module\s+(\S+)/);
      if (mod) {
        module = mod[1];
        continue;
      }
      if (line.startsWith("require (")) {
        inRequire = true;
        continue;
      }
      if (inRequire) {
        if (line === ")") {
          inRequire = false;
          continue;
        }
        const dep = line.match(/^(\S+)\s+(\S+)/);
        if (dep) declaredDeps.push({ name: dep[1], version: dep[2], type: "dependency" });
        continue;
      }
      const single = line.match(/^require\s+(\S+)\s+(\S+)/);
      if (single) declaredDeps.push({ name: single[1], version: single[2], type: "dependency" });
    }
    return {
      manifest: {
        id: `go:${module}`,
        name: module,
        ecosystem: "go",
        dir,
        manifestPath: normalize(path),
        declaredDeps,
      },
      isWorkspaceRoot: false,
    };
  },
};

// ---- Python / pyproject.toml ------------------------------------------------

/** Extract the distribution name from a PEP 508 requirement string. */
function pep508Name(req: string): string | null {
  const m = req.trim().match(/^[A-Za-z0-9._-]+/);
  return m ? m[0] : null;
}

const python: ManifestProvider = {
  ecosystem: "python",
  matches: (path) => baseName(path) === "pyproject.toml",
  parse(path, content) {
    const toml = parseToml(content);
    const dir = dirOf(path);
    const project = asTable(toml.project);
    const poetry = asTable(asTable(toml.tool)?.poetry);
    const name =
      (typeof project?.name === "string" && project.name) ||
      (typeof poetry?.name === "string" && poetry.name) ||
      lastSegment(dir);
    const declaredDeps: PackageDecl[] = [];
    if (Array.isArray(project?.dependencies)) {
      for (const d of project.dependencies) {
        const n = typeof d === "string" ? pep508Name(d) : null;
        if (n) declaredDeps.push({ name: n, type: "dependency" });
      }
    }
    const poetryDeps = asTable(poetry?.dependencies);
    if (poetryDeps) {
      for (const n of Object.keys(poetryDeps)) {
        if (n.toLowerCase() !== "python") declaredDeps.push({ name: n, type: "dependency" });
      }
    }
    return {
      manifest: {
        id: `python:${name}`,
        name,
        ecosystem: "python",
        dir,
        manifestPath: normalize(path),
        declaredDeps,
      },
      isWorkspaceRoot: false,
    };
  },
};

// ---- Maven / pom.xml (best-effort) -----------------------------------------

function firstTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return m ? m[1].trim() : null;
}

const maven: ManifestProvider = {
  ecosystem: "maven",
  matches: (path) => baseName(path) === "pom.xml",
  parse(path, content) {
    const dir = dirOf(path);
    // The project's own artifactId is the first one outside a <parent> block.
    const withoutParent = content.replace(/<parent>[\s\S]*?<\/parent>/g, "");
    const name = firstTag(withoutParent, "artifactId") ?? lastSegment(dir);
    const declaredDeps: PackageDecl[] = [];
    const depsBlock = content.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
    if (depsBlock) {
      for (const dep of depsBlock[1].matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const artifact = firstTag(dep[1], "artifactId");
        if (artifact)
          declaredDeps.push({
            name: artifact,
            version: firstTag(dep[1], "version") ?? undefined,
            type: "dependency",
          });
      }
    }
    return {
      manifest: {
        id: `maven:${name}`,
        name,
        ecosystem: "maven",
        dir,
        manifestPath: normalize(path),
        declaredDeps,
      },
      isWorkspaceRoot: false,
    };
  },
};

// ---- Gradle / settings.gradle[.kts] (name only) ----------------------------

const gradle: ManifestProvider = {
  ecosystem: "gradle",
  matches: (path) => /^settings\.gradle(\.kts)?$/.test(baseName(path)),
  parse(path, content) {
    const dir = dirOf(path);
    const m = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
    const name = m ? m[1] : lastSegment(dir);
    return {
      manifest: {
        id: `gradle:${name}`,
        name,
        ecosystem: "gradle",
        dir,
        manifestPath: normalize(path),
        declaredDeps: [],
      },
      isWorkspaceRoot: true,
    };
  },
};

export const PROVIDERS: readonly ManifestProvider[] = [npm, cargo, go, python, maven, gradle];
