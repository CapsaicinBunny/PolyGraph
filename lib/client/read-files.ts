import { IGNORE_DIR, MAX_FILE_BYTES, SOURCE_EXT } from "../file-filters";
import type { SourceFileMap } from "../graph/types";

function relativePath(file: File): string {
  const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  // Strip the selected root folder name so paths read as src/foo.ts, not myrepo/src/foo.ts.
  const segments = raw.split("/");
  return segments.length > 1 ? segments.slice(1).join("/") : raw;
}

export interface ReadResult {
  files: SourceFileMap;
  skipped: number;
}

/** Reports how many source files have been read so far, out of the total to read. */
export type ReadProgress = (done: number, total: number) => void;

/** Read a list of uploaded files into a path->source map, filtering non-source files. */
export async function readSourceFiles(
  fileList: FileList | File[],
  onProgress?: ReadProgress,
): Promise<ReadResult> {
  const files: SourceFileMap = {};
  let skipped = 0;

  // First pass: filter to the source files we actually intend to read, so progress
  // is reported against a meaningful total (not every file in node_modules).
  const candidates: { path: string; file: File }[] = [];
  for (const file of Array.from(fileList)) {
    const path = relativePath(file);
    if (!SOURCE_EXT.test(path) || IGNORE_DIR.test(path) || file.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    candidates.push({ path, file });
  }

  const total = candidates.length;
  let done = 0;
  onProgress?.(0, total);

  // Bounded concurrency: firing thousands of file.text() reads at once exhausts
  // the browser's file handles and throws NotReadableError. A small worker pool
  // caps it; a file that fails to read (moved/locked/permission) is skipped
  // rather than aborting the whole scan.
  const CONCURRENCY = 48;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const { path, file } = candidates[next++];
      try {
        files[path] = await file.text();
      } catch {
        skipped++;
      }
      done++;
      onProgress?.(done, total);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
  );

  return { files, skipped };
}
