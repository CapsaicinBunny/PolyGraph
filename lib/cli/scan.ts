// Produce a GraphModel for the CLI, either from the working tree on disk or from
// a git revision. Unlike the sidecar's runScan, there is no over-size
// confirmation gate here — a CI command must run to completion unattended.

import type { GraphModel } from "../graph/types";
import { analyzeProject } from "../kernel";
import { readPackageDeps } from "../server/package-deps";
import { scanDirectory } from "../server/scan-dir";
import { readRevisionSources, resolveRevision } from "./git";

export interface ScanResult {
  graph: GraphModel;
  fileCount: number;
  /** Human label for this scan: "working tree" or a revision name. */
  label: string;
}

/** Scan the working tree under `root`. */
export async function scanWorkingTree(root: string): Promise<ScanResult> {
  const { files } = await scanDirectory(root);
  const fileCount = Object.keys(files).length;
  if (fileCount === 0) throw new Error(`No source files found under ${root}`);
  const packages = await readPackageDeps(root);
  const { graph } = await analyzeProject(files, { packages });
  return { graph, fileCount, label: "working tree" };
}

/** Scan a git revision (branch/tag/SHA) of the repo at `root`. */
export async function scanRevision(root: string, rev: string): Promise<ScanResult> {
  await resolveRevision(root, rev);
  const { files, packages } = await readRevisionSources(root, rev);
  const fileCount = Object.keys(files).length;
  if (fileCount === 0) throw new Error(`No source files found at revision ${rev}`);
  const { graph } = await analyzeProject(files, { packages });
  return { graph, fileCount, label: rev };
}
