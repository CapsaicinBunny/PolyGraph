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
    },
  });

  for (const [path, text] of Object.entries(files)) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    project.createSourceFile(normalized, text, { overwrite: true });
  }

  return project;
}

/**
 * Normalize a ts-morph source file path back to the relative path the user
 * uploaded (strip the leading slash the in-memory FS requires).
 */
export function toRelativePath(absolutePath: string): string {
  return absolutePath.replace(/^\/+/, "");
}
