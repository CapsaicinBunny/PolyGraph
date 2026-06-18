import {
  type ClusterBox,
  type LayoutInput,
  type LayoutOptions,
  layoutView,
  type XYPosition,
} from "./layout";
import { smartLayout } from "./layout/smart";

export interface WorkerLayout {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}

type FlatPositions = [string, number, number][];

// Above how many nodes a heavy layout is forced down to near-linear `grid`. This is
// per-algorithm: `smart` is cluster-based and scales (telemetry: a 53k-node kernel
// cut laid out in ~0.28s) AND it produces the directory cluster boxes the adaptive
// cut needs — forcing it to grid (groupBy:"none") would strip those and defeat the
// LOD, so it gets plenty of headroom. Monolithic dagre (`layered`/`tree`) is ~O(V·E)
// and force is O(N·ticks); those stay capped low. The timeout below is the final
// safety for any pathological (dense) layout, regardless of algorithm.
const LAYOUT_MAX_HEAVY_SMART = 60_000;
const LAYOUT_MAX_HEAVY_OTHER = 6_000;
// If the worker hasn't answered in this long (hung on a pathological input), fall
// back to a synchronous grid so the "laying out…" overlay can't spin forever. Kept
// short so a dense, slow dagre layout can't freeze a frame for seconds — the grid
// fallback is near-instant on the (bounded) cut.
const LAYOUT_TIMEOUT_MS = 2000;

/** A cheap, near-linear layout used for huge inputs and as the timeout fallback. */
function gridOptions(options: LayoutOptions): LayoutOptions {
  return { ...options, algorithm: "grid", groupBy: "none" };
}

/** Force a near-linear layout only when the input is too large for the chosen algorithm. */
export function guardOptions(input: LayoutInput, options: LayoutOptions): LayoutOptions {
  const limit = options.algorithm === "smart" ? LAYOUT_MAX_HEAVY_SMART : LAYOUT_MAX_HEAVY_OTHER;
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
  if (options.algorithm === "smart") {
    const r = smartLayout(input, {
      direction: options.direction,
      groupBy: options.groupBy,
      density: options.density,
      communityOf: options.communityOf,
    });
    return { positions: r.nodes, clusters: r.clusters };
  }
  return { positions: layoutView(input, options), clusters: [] };
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
    // Guarantee termination: if the worker hangs, fall back to a synchronous grid.
    timer = setTimeout(() => finish(layoutSync(input, gridOptions(opts))), LAYOUT_TIMEOUT_MS);
    pending.set(id, finish);
    w.postMessage({ id, input, options: opts });
  });
}
