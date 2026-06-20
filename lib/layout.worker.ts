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
  const post = (result: ReturnType<typeof runLayout>) => {
    const flat: [string, number, number][] = [];
    result.nodes.forEach((p, key) => flat.push([key, p.x, p.y]));
    (self as unknown as Worker).postMessage({ id, positions: flat, clusters: result.clusters });
  };
  try {
    post(runLayout(input, options));
  } catch {
    // A layout engine threw (e.g. a dependency that doesn't run in this worker bundle). Post a
    // grid fallback immediately so the client gets a result instead of waiting out the 8s
    // timeout (which would also leave the "laying out…" overlay spinning).
    try {
      post(runLayout(input, { ...options, algorithm: "grid", groupBy: "none" }));
    } catch {
      (self as unknown as Worker).postMessage({ id, positions: [], clusters: [] });
    }
  }
};
