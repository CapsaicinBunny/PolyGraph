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
  const w = ensureWorker();
  if (!w) return Promise.resolve(layoutSync(input, options));
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, input, options });
  });
}
