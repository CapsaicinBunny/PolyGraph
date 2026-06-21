// Framework-agnostic analysis entry points shared by the Bun sidecar. These are
// the former Next.js API route bodies, returning plain data + a discriminated
// error instead of an HTTP Response. Scan runs the full multi-language kernel
// (analyzeProject), so a server-side scan now covers every supported language,
// not just TypeScript.

import { stat } from "node:fs/promises";
import type { CatalogWarning, DimensionCatalog } from "../graph/dimensions";
import type { PackageManifest } from "../graph/levels/types";
import { trimIfLarge } from "../graph/trim";
import type { AnalyzeError, GraphModel, SourceFileMap, UnresolvedRef } from "../graph/types";
import { analyzeProject } from "../kernel";
import { discoverPackages } from "./manifests";
import { readPackageDeps } from "./package-deps";
import { scanDirectory } from "./scan-dir";

export interface ScanData {
  graph: GraphModel;
  errors: AnalyzeError[];
  unresolved: UnresolvedRef[];
  fileCount: number;
  skipped: number;
  root: string;
  /** Packages discovered from manifest files, for the Package/Workspace levels. */
  manifests: PackageManifest[];
  /**
   * The merged dimension catalog (structural dims + EVERY provider's facets), so the
   * desktop client renders the real multi-language filter/group UI. Without it the app
   * falls back to the TS-only catalog and Rust/Go/etc. facets never surface. Optional to
   * mirror AnalyzeResult (the TS-only analyzeSources path leaves it unset).
   */
  dimensions?: DimensionCatalog;
  /** Non-fatal catalog-merge warnings (undeclared closed values, descriptor conflicts). */
  catalogWarnings?: CatalogWarning[];
  /** Engine timings (ms), carried to the client so they land in the session log. */
  timings: { scanMs: number; analyzeMs: number };
}

export interface AnalyzeData {
  graph: GraphModel;
  errors: AnalyzeError[];
  unresolved: UnresolvedRef[];
  manifests: PackageManifest[];
  dimensions?: DimensionCatalog;
  catalogWarnings?: CatalogWarning[];
}

/** Returned when a scan is large enough to warrant explicit confirmation. */
export interface OversizeResult {
  oversize: true;
  fileCount: number;
}

/**
 * Above this many source files, analysis produces a graph that's slow to build
 * and impractical to render, so the caller is asked to confirm before proceeding.
 */
export const SCAN_CONFIRM_THRESHOLD = 3000;

export type Handled<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface ScanOptions {
  /** Skip the over-size confirmation gate and analyze regardless. */
  force?: boolean;
  /** Override the confirmation threshold (for tests). */
  confirmThreshold?: number;
}

/** Validate + scan a directory on disk, then analyze it (unless it's over-size). */
export async function runScan(
  path: string | undefined,
  opts: ScanOptions = {},
): Promise<Handled<ScanData | OversizeResult>> {
  const root = path?.trim();
  if (!root) return { ok: false, status: 400, error: "Expected { path: string }" };

  try {
    const info = await stat(root);
    if (!info.isDirectory()) return { ok: false, status: 400, error: `Not a directory: ${root}` };
  } catch {
    return { ok: false, status: 400, error: `Path not found: ${root}` };
  }

  try {
    const tScan = performance.now();
    const { files, skipped } = await scanDirectory(root);
    const scanMs = performance.now() - tScan;
    const fileCount = Object.keys(files).length;
    if (fileCount === 0) {
      return { ok: false, status: 400, error: "No source files found under that path." };
    }
    // Over-size gate: hand the count back so the caller can confirm before we run
    // the (expensive) analysis on a huge codebase.
    const threshold = opts.confirmThreshold ?? SCAN_CONFIRM_THRESHOLD;
    if (!opts.force && fileCount > threshold) {
      console.error(
        `[scan] ${fileCount} files read in ${scanMs.toFixed(0)}ms — over ${threshold}, awaiting confirmation`,
      );
      return { ok: true, value: { oversize: true, fileCount } };
    }
    const packages = await readPackageDeps(root);
    const manifests = discoverPackages(files);
    const tAnalyze = performance.now();
    const analyzed = await analyzeProject(files, { packages });
    // On a huge graph, edge occurrences dominate the payload and can push
    // JSON.stringify past V8's string ceiling — trim them to a sample (count kept).
    const graph = trimIfLarge(analyzed.graph);
    const { errors, unresolved, dimensions, catalogWarnings } = analyzed;
    const analyzeMs = performance.now() - tAnalyze;
    console.error(
      `[scan] ${fileCount} files | read ${scanMs.toFixed(0)}ms | analyze ${analyzeMs.toFixed(0)}ms | ${graph.nodes.length} nodes, ${graph.edges.length} edges | ${manifests.length} packages | ${dimensions?.descriptors.length ?? 0} dims, ${catalogWarnings?.length ?? 0} warnings`,
    );
    return {
      ok: true,
      value: {
        graph,
        errors,
        unresolved,
        fileCount,
        skipped,
        root,
        manifests,
        dimensions,
        catalogWarnings,
        timings: { scanMs, analyzeMs },
      },
    };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Scan failed" };
  }
}

/** Analyze an in-memory file map (the browser-read fallback path). */
export async function runAnalyze(files: SourceFileMap | undefined): Promise<Handled<AnalyzeData>> {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { ok: false, status: 400, error: "Expected { files: Record<string, string> }" };
  }
  try {
    const t = performance.now();
    const { graph, errors, unresolved, dimensions, catalogWarnings } = await analyzeProject(files);
    const manifests = discoverPackages(files);
    console.error(
      `[analyze] ${Object.keys(files).length} files | ${(performance.now() - t).toFixed(0)}ms | ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    );
    return { ok: true, value: { graph, errors, unresolved, manifests, dimensions, catalogWarnings } };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Analysis failed",
    };
  }
}
