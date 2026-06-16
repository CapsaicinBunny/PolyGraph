import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { IGNORE_DIR, MAX_FILE_BYTES, SOURCE_EXT } from "../file-filters";
import type { SourceFileMap } from "../graph/types";

export interface ScanResult {
  files: SourceFileMap;
  skipped: number;
}

/**
 * Recursively read a directory on the server's filesystem into a path->source
 * map. Reads files in place (no copy/upload) and prunes ignored directories
 * (node_modules, .git, build output, …) instead of descending into them.
 */
export async function scanDirectory(root: string): Promise<ScanResult> {
  const files: SourceFileMap = {};
  let skipped = 0;

  const toRel = (full: string) => relative(root, full).split(sep).join("/");

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
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        files[rel] = await readFile(full, "utf8");
      }
    }
  }

  await walk(root);
  return { files, skipped };
}
