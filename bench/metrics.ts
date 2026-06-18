// Timing, memory, and summary-stat helpers for the benchmark harness. No deps —
// just performance.now() + process.memoryUsage(), which is all Bun needs.

export interface TimeStat {
  /** Median wall-clock ms across iterations. */
  median: number;
  min: number;
  max: number;
  iterations: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Run `fn` `iterations` times (after `warmup` untimed runs) and report median/min/max ms. */
export async function timeIt(fn: () => unknown, iterations = 5, warmup = 1): Promise<TimeStat> {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  return {
    median: round(median(samples)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    iterations,
  };
}

export interface MemStat {
  /** Peak resident-set growth during the call, MB. */
  rssMb: number;
  /** Heap-used growth during the call, MB. */
  heapMb: number;
}

/** Measure RSS/heap growth across a single call. Forces GC first when exposed (--expose-gc). */
export async function measureMemory(fn: () => unknown): Promise<MemStat> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  const before = process.memoryUsage();
  await fn();
  if (gc) gc();
  const after = process.memoryUsage();
  return {
    rssMb: round((after.rss - before.rss) / 1_048_576),
    heapMb: round((after.heapUsed - before.heapUsed) / 1_048_576),
  };
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Stable FNV-1a hash of a string → hex, for content snapshots. */
export function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
