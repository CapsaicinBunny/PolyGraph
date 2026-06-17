// Read source files from a git revision (branch, tag, or SHA) without touching
// the working tree — the basis for `--baseline` checks and `diff` comparisons.
// Uses git plumbing via child_process so it works the same on every platform.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IGNORE_DIR, MAX_FILE_BYTES, SOURCE_EXT } from "../file-filters";
import type { DependencyType, SourceFileMap } from "../graph/types";
import type { PackageDep, PackageDeps } from "../server/package-deps";

const exec = promisify(execFile);

// git output can be large (whole-file contents); lift the default 1 MB cap.
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

/** Verify a revision resolves; throws a friendly error otherwise. */
export async function resolveRevision(root: string, rev: string): Promise<string> {
  try {
    return (await git(root, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
  } catch {
    throw new Error(`Cannot resolve git revision "${rev}" (not a branch, tag, or commit?)`);
  }
}

/** Run async `task` over `items` with bounded concurrency, preserving order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function flattenDeps(pkg: Record<string, unknown>): PackageDeps {
  const deps: PackageDeps = {};
  const add = (section: unknown, type: DependencyType) => {
    if (!section || typeof section !== "object") return;
    for (const [name, version] of Object.entries(section as Record<string, unknown>)) {
      deps[name] = { version: String(version), type } satisfies PackageDep;
    }
  };
  add(pkg.dependencies, "dependency");
  add(pkg.devDependencies, "devDependency");
  add(pkg.peerDependencies, "peerDependency");
  add(pkg.optionalDependencies, "optionalDependency");
  return deps;
}

export interface RevisionSources {
  files: SourceFileMap;
  packages: PackageDeps;
}

/**
 * Materialize the source files (and package.json deps) of a revision into the
 * same in-memory shape the analyzer expects. Applies the project's standard
 * source-extension / ignored-directory / size filters.
 */
export async function readRevisionSources(root: string, rev: string): Promise<RevisionSources> {
  const listing = await git(root, ["ls-tree", "-r", "--name-only", rev]);
  const candidates = listing
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p && SOURCE_EXT.test(p) && !IGNORE_DIR.test(p));

  const entries = await mapPool(candidates, 16, async (path) => {
    try {
      const content = await git(root, ["show", `${rev}:${path}`]);
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return null;
      return [path, content] as const;
    } catch {
      return null; // unreadable at this rev (e.g. a symlink or binary blob)
    }
  });

  const files: SourceFileMap = {};
  for (const e of entries) if (e) files[e[0]] = e[1];

  let packages: PackageDeps = {};
  try {
    const pkgText = await git(root, ["show", `${rev}:package.json`]);
    packages = flattenDeps(JSON.parse(pkgText) as Record<string, unknown>);
  } catch {
    // No package.json at this revision — externals just won't carry versions.
  }

  return { files, packages };
}
