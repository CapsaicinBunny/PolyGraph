import { Project, ts } from "ts-morph";
import type { SourceFileMap } from "../graph/types";

/**
 * Build an in-memory ts-morph Project from a map of relative path -> source text.
 *
 * Uses an in-memory file system so no disk access occurs. Type resolution still
 * works across the uploaded files, which is what the call analyzer relies on.
 */
export function createInMemoryProject(files: SourceFileMap): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      // We only need parsing + symbol resolution, not emit or full type checking.
      noresolve: false,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      // Resolve the most common path aliases so `@/x` imports link to project files
      // instead of looking like external packages. Files live under "/" in the
      // in-memory FS, so `@/*` and `~/*` map to the project root.
      baseUrl: "/",
      paths: {
        "@/*": ["*"],
        "~/*": ["*"],
      },
    },
  });

  for (const [path, text] of Object.entries(files)) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const isSfc = /\.(vue|svelte)$/i.test(path);
    // .vue / .svelte are not TS — analyze the embedded <script> block(s) as TS.
    const content = isSfc ? extractScript(text) : text;
    project.createSourceFile(normalized, content, {
      overwrite: true,
      ...(isSfc ? { scriptKind: ts.ScriptKind.TS } : {}),
    });
  }

  return project;
}

/** Concatenate the contents of every `<script>` block in a Vue/Svelte single-file component. */
function extractScript(sfc: string): string {
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = re.exec(sfc);
  while (match) {
    blocks.push(match[1]);
    match = re.exec(sfc);
  }
  return blocks.join("\n");
}

/**
 * Normalize a ts-morph source file path back to the relative path the user
 * uploaded (strip the leading slash the in-memory FS requires).
 */
export function toRelativePath(absolutePath: string): string {
  return absolutePath.replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Structural module resolution (checker-free).
//
// When a huge repo is analyzed in batches, each ts-morph Project only sees the
// files in its own batch, so its type checker cannot resolve an import whose
// target lives in another batch. To keep the import-edge backbone complete we
// resolve such specifiers STRUCTURALLY — by module path against the full file
// set — mirroring the relative + `@/` / `~/` alias resolution that the
// in-memory Project's compiler options configure. This never invokes the
// checker, so no AST/type state is retained.
// ---------------------------------------------------------------------------

/** Candidate file extensions tried when a specifier omits one. Order matters. */
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".vue",
  ".svelte",
] as const;

/** Index-file bases tried when a specifier resolves to a directory. */
const INDEX_BASES = [
  "/index.ts",
  "/index.tsx",
  "/index.d.ts",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
] as const;

/** A specifier that targets a project file: relative or a known path alias. */
function isProjectModuleSpecifier(spec: string): boolean {
  return (
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    spec.startsWith("@/") ||
    spec.startsWith("~/")
  );
}

/** Collapse `a/b/../c` and `a/./b` segments into a normalized absolute-ish path. */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve an import/export specifier against the set of known relative file
 * paths, returning the matched file's relative path or `undefined`.
 *
 * `fromFile` is the relative path of the importing file. The same alias map as
 * {@link createInMemoryProject} (`@/*` and `~/*` → project root) is applied.
 * Resolution mirrors TS module resolution closely enough for project-internal
 * relative/alias imports: it tries the literal path, then known extensions,
 * then `index.*` directory entries.
 */
export function resolveModuleSpecifier(
  spec: string,
  fromFile: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  if (!isProjectModuleSpecifier(spec)) return undefined; // bare specifier → external

  // Strip a query/hash suffix some bundler specifiers carry (e.g. `./x?raw`).
  const clean = spec.replace(/[?#].*$/, "");

  let base: string;
  if (clean.startsWith("@/") || clean.startsWith("~/")) {
    // Aliases map to the project root.
    base = clean.slice(2);
  } else if (clean.startsWith("/")) {
    base = clean.slice(1);
  } else {
    // Relative to the importer's directory.
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    base = `${dir}/${clean}`;
  }

  const target = normalizeSegments(base);
  if (!target) return undefined;

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${target}${ext}`;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const idx of INDEX_BASES) {
    const candidate = `${target}${idx}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Partition file paths into batches grouped by top-level directory so that most
 * intra-directory imports stay within a single batch. Directories are packed
 * into batches of at most `batchSize` files; a directory larger than the batch
 * size is split across batches (its files stay contiguous). The original file
 * order within each directory is preserved.
 */
export function batchPathsByDirectory(paths: string[], batchSize: number): string[][] {
  if (batchSize < 1) return paths.length ? [paths] : [];

  // Group by the directory containing each file, preserving first-seen order.
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(path);
    else byDir.set(dir, [path]);
  }

  const batches: string[][] = [];
  let current: string[] = [];
  for (const group of byDir.values()) {
    // A directory bigger than a batch is emitted as its own (oversized) batch
    // rather than being interleaved with unrelated directories.
    if (group.length >= batchSize) {
      if (current.length) {
        batches.push(current);
        current = [];
      }
      batches.push(group);
      continue;
    }
    if (current.length + group.length > batchSize && current.length) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push(current);
  return batches;
}
