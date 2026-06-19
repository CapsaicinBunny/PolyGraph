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
  const result = runLayout(input, options);
  const flat: [string, number, number][] = [];
  result.nodes.forEach((p, key) => flat.push([key, p.x, p.y]));
  (self as unknown as Worker).postMessage({ id, positions: flat, clusters: result.clusters });
};
