// Benchmark fixtures: small committed sample projects (stable, used by the golden
// and layout-stability snapshots), the PolyGraph repo itself (a real-world sample),
// and an optional manifest of pinned real-world repos fetched on demand (see fetch.ts).

import { existsSync } from "node:fs";
import { scanDirectory } from "../lib/server/scan-dir";
import { readPackageDeps } from "../lib/server/package-deps";
import type { SourceFileMap } from "../lib/graph/types";
import type { PackageDeps } from "../lib/server/package-deps";

export interface Fixture {
  id: string;
  label: string;
  /** Dominant language, for the "scan time by language" breakdown. */
  language: string;
  /** Absolute path on disk. */
  root: string;
  /** Committed + content-stable → safe for golden / layout-stability snapshots. */
  stable?: boolean;
}

const here = import.meta.dir;
const repoRoot = `${here}/..`;

/** Always-available fixtures (committed samples + this repo). */
export const LOCAL_FIXTURES: Fixture[] = [
  {
    id: "sample-ts",
    label: "sample (TS)",
    language: "TypeScript",
    root: `${here}/fixtures/sample`,
    stable: true,
  },
  {
    id: "sample-py",
    label: "sample (Python)",
    language: "Python",
    root: `${here}/fixtures/sample-py`,
    stable: true,
  },
  {
    id: "sample-go",
    label: "sample (Go)",
    language: "Go",
    root: `${here}/fixtures/sample-go`,
    stable: true,
  },
  { id: "self", label: "PolyGraph (self)", language: "TypeScript+Rust", root: repoRoot },
];

/**
 * Optional pinned real-world repos for per-language + size-scaling perf. Fetched
 * into bench/.fixtures/<id> (gitignored) by `bun run bench:fetch`, pinned to a sha
 * for reproducibility. Empty by default so the core suite runs offline; add repos
 * here to broaden coverage.
 */
export interface RemoteFixture extends Fixture {
  repo: string;
  sha: string;
}
export const REMOTE_FIXTURES: RemoteFixture[] = [
  // Example (uncomment + pin a sha to enable):
  // { id: "ts-small", label: "type-fest (TS)", language: "TypeScript",
  //   repo: "https://github.com/sindresorhus/type-fest", sha: "<commit-sha>",
  //   root: `${here}/.fixtures/ts-small` },
];

export function remoteFixtureRoot(id: string): string {
  return `${here}/.fixtures/${id}`;
}

/** Fixtures present on disk right now (committed samples + self + any fetched remotes). */
export function availableFixtures(): Fixture[] {
  return [...LOCAL_FIXTURES, ...REMOTE_FIXTURES.filter((f) => existsSync(f.root))].filter((f) =>
    existsSync(f.root),
  );
}

export function stableFixtures(): Fixture[] {
  return availableFixtures().filter((f) => f.stable);
}

export interface LoadedFixture extends Fixture {
  files: SourceFileMap;
  packages: PackageDeps;
  fileCount: number;
}

/** Read a fixture's source files from disk (no copy/upload — same path the app uses). */
export async function loadFixture(fx: Fixture): Promise<LoadedFixture> {
  const { files } = await scanDirectory(fx.root);
  const packages = await readPackageDeps(fx.root).catch(() => ({}) as PackageDeps);
  return { ...fx, files, packages, fileCount: Object.keys(files).length };
}
