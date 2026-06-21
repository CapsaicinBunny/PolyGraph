// A small LRU of analyzed projects, keyed by absolute root path. Scanning is the
// expensive step (read + parse + resolve every file); an agent typically scans a
// project once and then runs many queries against it, so we keep the last few
// results in memory. The `scan` tool force-refreshes; the others reuse a cached
// scan (or scan on demand if the path hasn't been seen yet).

import { resolve } from "node:path";
import { runScan, type ScanData } from "../lib/server/handlers";

const cache = new Map<string, ScanData>();
const MAX_ENTRIES = 4;

/** Resolve to an absolute path so cache keys are stable regardless of the caller's cwd. */
export function rootKey(path: string): string {
  return resolve(path);
}

/**
 * Return the analyzed graph for `path`, scanning (and caching) if needed.
 * `refresh: true` forces a fresh scan even when a cached result exists.
 */
export async function getScan(path: string, opts: { refresh?: boolean } = {}): Promise<ScanData> {
  const root = rootKey(path);
  if (!opts.refresh) {
    const hit = cache.get(root);
    if (hit) {
      cache.delete(root);
      cache.set(root, hit); // move to most-recently-used
      return hit;
    }
  }

  // force:true skips the sidecar's over-size confirmation gate — an MCP call must
  // run to completion unattended, like the CLI.
  const r = await runScan(root, { force: true });
  if (!r.ok) throw new Error(r.error);
  if (!("graph" in r.value)) {
    throw new Error(`Scan of "${root}" did not produce a graph.`); // unreachable with force:true
  }

  const data = r.value;
  cache.delete(root);
  cache.set(root, data);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return data;
}

/** Drop all cached scans (used by tests). */
export function clearScanCache(): void {
  cache.clear();
}
