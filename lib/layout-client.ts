import {
  type ClusterBox,
  type LayoutInput,
  type LayoutOptions,
  runLayout,
  type XYPosition,
} from "./layout";

export interface WorkerLayout {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}

type FlatPositions = [string, number, number][];

// Smart WITH grouping (groupBy !== "none") scales: it clusters by directory/community
// and runs small per-cluster layouts, and the adaptive LOD cut bounds its input — so it
// gets high headroom. EVERY other path (an explicitly selected engine, Community, None)
// is bounded only here plus the per-component caps in lib/layout.ts, so it stays low.
// Critically, Smart+grouping must NOT be forced to grid: grid emits ZERO cluster boxes,
// which self-disables the LOD cut (it measures dir-keyed boxes to drive the recut).
const LAYOUT_MAX_SCALABLE = 60_000;
const LAYOUT_MAX_HEAVY = 6000;
// If the worker hasn't answered in this long (hung on a pathological input), fall back
// to a synchronous grid so the "laying out…" overlay can't spin forever. A safety net
// for the deterministic heavy engines, not a tuning knob — keep it 8000.
const LAYOUT_TIMEOUT_MS = 8000;

/** A cheap, near-linear layout used for huge inputs and as the timeout fallback. */
function gridOptions(options: LayoutOptions): LayoutOptions {
  return { ...options, algorithm: "grid", groupBy: "none" };
}

/**
 * Force a near-linear layout when the input is too large for the chosen algorithm.
 * Per-algorithm: Smart+grouping scales (high headroom); everything else caps low and
 * relies on the per-component caps in lib/layout.ts for the rest.
 */
export function guardOptions(input: LayoutInput, options: LayoutOptions): LayoutOptions {
  const scalesWell = options.algorithm === "smart" && options.groupBy !== "none";
  const limit = scalesWell ? LAYOUT_MAX_SCALABLE : LAYOUT_MAX_HEAVY;
  return input.nodes.length > limit ? gridOptions(options) : options;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (result: WorkerLayout) => void>();

function ensureWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (
      e: MessageEvent<{ id: number; positions: FlatPositions; clusters: ClusterBox[] }>,
    ) => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      const positions = new Map<string, XYPosition>();
      for (const [id, x, y] of e.data.positions) positions.set(id, { x, y });
      resolve({ positions, clusters: e.data.clusters });
    };
    worker.onerror = () => {
      // Disable the worker on error; future calls fall back to the main thread.
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Synchronous fallback shared with the no-Worker path (and tests). */
function layoutSync(input: LayoutInput, options: LayoutOptions): WorkerLayout {
  const r = runLayout(input, options);
  return { positions: r.nodes, clusters: r.clusters };
}

/**
 * Compute a layout on a Web Worker so the main thread stays responsive. Falls back
 * to synchronous main-thread layout if workers are unavailable.
 */
export function layoutInWorker(input: LayoutInput, options: LayoutOptions): Promise<WorkerLayout> {
  const opts = guardOptions(input, options);
  const w = ensureWorker();
  if (!w) return Promise.resolve(layoutSync(input, opts));
  const id = ++seq;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: WorkerLayout) => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      clearTimeout(timer);
      resolve(result);
    };
    // Guarantee termination: if the worker hangs on a pathological input, KILL it (so it can't
    // block every future layout — a wedged worker would make the next request queue behind it
    // and time out too) and fall back to a synchronous grid. The next call spins up a fresh worker.
    timer = setTimeout(() => {
      try {
        worker?.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
      finish(layoutSync(input, gridOptions(opts)));
    }, LAYOUT_TIMEOUT_MS);
    pending.set(id, finish);
    w.postMessage({ id, input, options: opts });
  });
}
