// Rolling numeric metrics: named histograms (for timings/sizes — frame ms, cut
// compute ms, payload bytes) and counters. Histograms keep a bounded window of
// recent samples for percentiles, plus an all-time count, so memory stays
// bounded over a long session. Pure.

export interface HistogramSummary {
  count: number; // samples in the current window
  total: number; // all-time records
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Nearest-rank pick from an already-sorted ascending (non-empty) array. */
function rankOf(sorted: number[], p: number): number {
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/** A rolling histogram over the last `window` samples. */
export class Histogram {
  private samples: number[] = [];
  private idx = 0;
  private filled = false;
  private totalCount = 0;

  constructor(readonly window = 1000) {}

  record(v: number): void {
    if (this.samples.length < this.window) {
      this.samples.push(v);
    } else {
      this.samples[this.idx] = v;
      this.idx = (this.idx + 1) % this.window;
      this.filled = true;
    }
    this.totalCount += 1;
  }

  get count(): number {
    return this.filled ? this.window : this.samples.length;
  }

  get total(): number {
    return this.totalCount;
  }

  /** `p` in [0, 1]; nearest-rank over the current window. NaN when empty. */
  percentile(p: number): number {
    const n = this.samples.length;
    if (n === 0) return NaN;
    return rankOf(
      [...this.samples].sort((a, b) => a - b),
      p,
    );
  }

  summary(): HistogramSummary {
    const n = this.samples.length;
    if (n === 0) {
      return { count: 0, total: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }
    // Sort once; min/max are the ends and every percentile indexes the same array,
    // so the summary is internally consistent and cheap (was 3× sort per snapshot).
    const sorted = [...this.samples].sort((a, b) => a - b);
    let sum = 0;
    for (const v of this.samples) sum += v;
    return {
      count: n,
      total: this.totalCount,
      mean: sum / n,
      min: sorted[0],
      max: sorted[n - 1],
      p50: rankOf(sorted, 0.5),
      p95: rankOf(sorted, 0.95),
      p99: rankOf(sorted, 0.99),
    };
  }

  reset(): void {
    this.samples = [];
    this.idx = 0;
    this.filled = false;
    this.totalCount = 0;
  }
}

/** Registry of named histograms + counters. */
export class Metrics {
  private histograms = new Map<string, Histogram>();
  private counters = new Map<string, number>();

  histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    return h;
  }

  record(name: string, value: number): void {
    this.histogram(name).record(value);
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): { histograms: Record<string, HistogramSummary>; counters: Record<string, number> } {
    const histograms: Record<string, HistogramSummary> = {};
    for (const [k, h] of this.histograms) histograms[k] = h.summary();
    return { histograms, counters: Object.fromEntries(this.counters) };
  }

  reset(): void {
    this.histograms.clear();
    this.counters.clear();
  }
}
