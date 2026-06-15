import type { SourceFileMap } from "../graph/types";

const SOURCE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;
const IGNORE_DIR =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.turbo|\.cache)(\/|$)/;
const MAX_FILE_BYTES = 1_000_000; // skip very large files (likely generated/minified)

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

/** Read a list of uploaded files into a path->source map, filtering non-source files. */
export async function readSourceFiles(fileList: FileList | File[]): Promise<ReadResult> {
  const files: SourceFileMap = {};
  let skipped = 0;

  const all = Array.from(fileList);
  await Promise.all(
    all.map(async (file) => {
      const path = relativePath(file);
      if (!SOURCE_EXT.test(path) || IGNORE_DIR.test(path)) {
        skipped++;
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        skipped++;
        return;
      }
      files[path] = await file.text();
    }),
  );

  return { files, skipped };
}
