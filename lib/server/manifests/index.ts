// Manifest discovery: run every file in a scan through the matching provider, then
// resolve workspace membership (a package nested under a workspace-root directory joins
// that workspace).

import type { PackageManifest } from "../../graph/levels/types";
import { type ManifestProvider, type ParsedManifest, PROVIDERS } from "./providers";

export type { ManifestProvider } from "./providers";
export { PROVIDERS } from "./providers";

function providerFor(path: string): ManifestProvider | undefined {
  return PROVIDERS.find((p) => p.matches(path));
}

function dirContains(dir: string, other: string): boolean {
  if (dir === "") return other !== "";
  return other === dir || other.startsWith(`${dir}/`);
}

/**
 * Discover packages from a map of relative path → file content. Only manifest files are
 * read; everything else is ignored. Returns one PackageManifest per package, with
 * `workspace` filled in for members of a workspace root.
 */
export function discoverPackages(files: Record<string, string>): PackageManifest[] {
  const parsed: ParsedManifest[] = [];
  for (const [path, content] of Object.entries(files)) {
    const provider = providerFor(path);
    if (!provider) continue;
    const result = provider.parse(path, content);
    if (result) parsed.push(result);
  }

  const roots = parsed.filter((p) => p.isWorkspaceRoot);
  for (const p of parsed) {
    // Deepest enclosing workspace root wins (a package can sit inside nested workspaces).
    let best: ParsedManifest | undefined;
    for (const r of roots) {
      if (r === p) continue;
      if (dirContains(r.manifest.dir, p.manifest.dir)) {
        if (!best || r.manifest.dir.length > best.manifest.dir.length) best = r;
      }
    }
    const root = best ?? (p.isWorkspaceRoot ? p : undefined);
    if (root) p.manifest.workspace = root.manifest.name;
  }

  return parsed.map((p) => p.manifest);
}
