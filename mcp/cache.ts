// A small LRU of analyzed projects, keyed by absolute root path. Scanning is the
// expensive step (read + parse + resolve every file); an agent typically scans a
// project once and then runs many queries against it, so we keep the last few
// results in memory. The `scan` tool force-refreshes; the others reuse a cached
// scan (or scan on demand if the path hasn't been seen yet).

import { resolve } from "node:path";
import { runScan, type ScanData } from "../lib/server/handlers";

/**
 * A scan plus when it was taken. Every tool echoes `scannedAt` so a caller can tell
 * a fresh answer from one computed against a snapshot taken before its own edits —
 * only `polygraph_scan` refreshes, so without this the staleness is invisible.
 */
export type CachedScan = ScanData & { scannedAt: number };

const cache = new Map<string, CachedScan>();
// In-flight scans, so N concurrent tool calls against an uncached root do one scan
// rather than N. MCP clients routinely fan out calls, and the scan is precisely the
// work this cache exists to avoid repeating.
const inFlight = new Map<string, Promise<CachedScan>>();
// Enough to keep a couple of projects (and their git-diff revisions) warm without
// holding many full graphs in memory at once.
const MAX_ENTRIES = 4;

/** Resolve to an absolute path so cache keys are stable regardless of the caller's cwd. */
export function rootKey(path: string): string {
  return resolve(path);
}

async function scanNow(root: string): Promise<CachedScan> {
  // force:true skips runScan's over-size confirmation gate (lib/server/handlers.ts) —
  // an MCP call must run to completion unattended, like the CLI.
  const r = await runScan(root, { force: true });
  if (!r.ok) {
    // runScan's own messages are terse and one of them ("No source files found under
    // that path.") names no path at all, which is the single most likely agent
    // mistake. Add the root and say whether retrying elsewhere could even help.
    const actionable =
      r.status >= 500
        ? "This is an internal analysis failure, not a bad path — retrying with a different path will not help."
        : `Check that "${root}" exists and contains source files PolyGraph can parse (.ts/.tsx/.js/.py/.rs/.go/…).`;
    throw new Error(`Scan of "${root}" failed: ${r.error} ${actionable}`);
  }
  if (!("graph" in r.value)) {
    throw new Error(`Scan of "${root}" did not produce a graph.`); // unreachable with force:true
  }

  const data: CachedScan = { ...r.value, scannedAt: Date.now() };
  cache.delete(root);
  cache.set(root, data);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return data;
}

/**
 * Return the analyzed graph for `path`, scanning (and caching) if needed.
 * `refresh: true` forces a fresh scan even when a cached result exists.
 */
export async function getScan(path: string, opts: { refresh?: boolean } = {}): Promise<CachedScan> {
  const root = rootKey(path);
  if (!opts.refresh) {
    const hit = cache.get(root);
    if (hit) {
      cache.delete(root);
      cache.set(root, hit); // move to most-recently-used
      return hit;
    }
    const pending = inFlight.get(root);
    if (pending) return pending;
  }

  const p = scanNow(root).finally(() => {
    inFlight.delete(root);
  });
  inFlight.set(root, p);
  return p;
}

/** Drop all cached scans (used by tests). */
export function clearScanCache(): void {
  cache.clear();
  inFlight.clear();
}

/** The cached root keys, least-recently-used first (a test seam for LRU assertions). */
export function cacheKeys(): string[] {
  return [...cache.keys()];
}
