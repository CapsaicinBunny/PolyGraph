/// <reference lib="webworker" />
import { type LayoutInput, type LayoutOptions, runLayout } from "./layout";

interface Request {
  id: number;
  input: LayoutInput;
  options: LayoutOptions;
}

// Run layout off the main thread and post back flat positions + cluster boxes.
self.onmessage = (event: MessageEvent<Request>) => {
  const { id, input, options } = event.data;
  const post = (result: ReturnType<typeof runLayout>, error?: string) => {
    const flat: [string, number, number][] = [];
    result.nodes.forEach((p, key) => flat.push([key, p.x, p.y]));
    (self as unknown as Worker).postMessage({
      id,
      positions: flat,
      clusters: result.clusters,
      ...(error ? { error } : {}),
    });
  };
  try {
    post(runLayout(input, options));
  } catch (err) {
    // A layout engine threw (e.g. a dependency that doesn't run in this worker bundle). Post a
    // grid fallback immediately — with the error so the client can log it — instead of waiting
    // out the 8s timeout (which would also leave the "laying out…" overlay spinning).
    const msg = err instanceof Error ? err.message : String(err);
    try {
      post(runLayout(input, { ...options, algorithm: "grid", groupBy: "none" }), msg);
    } catch {
      (self as unknown as Worker).postMessage({ id, positions: [], clusters: [], error: msg });
    }
  }
};
