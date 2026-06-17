import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { IGNORE_DIR, MAX_FILE_BYTES, SOURCE_EXT } from "../file-filters";
import type { SourceFileMap } from "../graph/types";

export interface ScanResult {
  files: SourceFileMap;
  skipped: number;
}

// Number of file reads kept in flight at once. Small enough to avoid exhausting
// file descriptors on large trees, large enough to overlap I/O latency.
const READ_CONCURRENCY = 16;

interface Candidate {
  full: string;
  rel: string;
}

/**
 * Recursively read a directory on the server's filesystem into a path->source
 * map. Reads files in place (no copy/upload) and prunes ignored directories
 * (node_modules, .git, build output, …) instead of descending into them.
 *
 * Candidate files are collected during the directory walk, then their contents
 * are read with bounded concurrency so a large tree isn't serialized on I/O.
 */
export async function scanDirectory(root: string): Promise<ScanResult> {
  const files: SourceFileMap = {};
  let skipped = 0;

  const toRel = (full: string) => relative(root, full).split(sep).join("/");

  const candidates: Candidate[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toRel(full);

      if (entry.isDirectory()) {
        if (IGNORE_DIR.test(`${rel}/`)) continue; // don't descend into ignored dirs
        await walk(full);
      } else if (entry.isFile()) {
        if (!SOURCE_EXT.test(rel) || IGNORE_DIR.test(rel)) {
          skipped++;
          continue;
        }
        candidates.push({ full, rel });
      }
    }
  }

  await walk(root);

  // Read candidate contents with a bounded worker pool. Each worker pulls the
  // next index off a shared cursor, so at most READ_CONCURRENCY reads (incl. the
  // stat size check) are in flight at once. Semantics match the sequential
  // version: oversize files bump `skipped`, others land in `files` by rel key.
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= candidates.length) return;
      const { full, rel } = candidates[i]!;
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      files[rel] = await readFile(full, "utf8");
    }
  }

  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, candidates.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  return { files, skipped };
}
