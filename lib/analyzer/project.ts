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
