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

// Heavy layouts (dagre `layered`/`tree`/`smart`, d3-`force`) don't scale: dagre is
// ~O(V·E) and unusable past ~10k nodes, force is O(N·ticks). Above this node count
// force a near-linear `grid` so layout always terminates. (Auto-collapse normally
// keeps inputs far below this; this is defense in depth — see docs/SCALE-100K.md.)
const LAYOUT_MAX_HEAVY = 6000;
// If the worker hasn't answered in this long (hung on a pathological input), fall
// back to a synchronous grid so the "laying out…" overlay can't spin forever.
const LAYOUT_TIMEOUT_MS = 8000;

/** A cheap, near-linear layout used for huge inputs and as the timeout fallback. */
function gridOptions(options: LayoutOptions): LayoutOptions {
  return { ...options, algorithm: "grid", groupBy: "none" };
}

/** Force a near-linear layout when the input is too large for the heavy algorithms. */
export function guardOptions(input: LayoutInput, options: LayoutOptions): LayoutOptions {
  return input.nodes.length > LAYOUT_MAX_HEAVY ? gridOptions(options) : options;
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
    // Guarantee termination: if the worker hangs, fall back to a synchronous grid.
    timer = setTimeout(() => finish(layoutSync(input, gridOptions(opts))), LAYOUT_TIMEOUT_MS);
    pending.set(id, finish);
    w.postMessage({ id, input, options: opts });
  });
}
