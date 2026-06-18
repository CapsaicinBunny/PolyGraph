import { join } from "node:path";
import { Circle, Drawing, Rectangle } from "./shapes";

export function buildDrawing(): Drawing {
  const d = new Drawing();
  d.add(new Circle(2));
  d.add(new Rectangle(3, 4));
  return d;
}

export function report(): string {
  const total = buildDrawing().total();
  return join("out", `total-${total.toFixed(2)}.txt`);
}
