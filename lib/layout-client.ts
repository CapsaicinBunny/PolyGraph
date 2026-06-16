import { type LayoutInput, type LayoutOptions, layoutView, type XYPosition } from "./layout";

type PositionMap = Map<string, XYPosition>;
type FlatPositions = [string, number, number][];

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (positions: PositionMap) => void>();

function ensureWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; positions: FlatPositions }>) => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      const map: PositionMap = new Map();
      for (const [id, x, y] of e.data.positions) map.set(id, { x, y });
      resolve(map);
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

/**
 * Compute a layout on a Web Worker so the main thread stays responsive. Falls back
 * to synchronous main-thread layout if workers are unavailable.
 */
export function layoutInWorker(input: LayoutInput, options: LayoutOptions): Promise<PositionMap> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(layoutView(input, options));
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, input, options });
  });
}
