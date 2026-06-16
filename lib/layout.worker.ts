/// <reference lib="webworker" />
import { type LayoutInput, type LayoutOptions, layoutView } from "./layout";

interface Request {
  id: number;
  input: LayoutInput;
  options: LayoutOptions;
}

// Run the (potentially expensive) dagre/d3-force layout off the main thread and
// post back a flat [id, x, y] list (cheaper to clone than a Map of objects).
self.onmessage = (event: MessageEvent<Request>) => {
  const { id, input, options } = event.data;
  const positions = layoutView(input, options);
  const flat: [string, number, number][] = [];
  positions.forEach((p, key) => flat.push([key, p.x, p.y]));
  (self as unknown as Worker).postMessage({ id, positions: flat });
};
