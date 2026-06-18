import { buildDrawing } from "./app";
import { circleArea } from "./geometry";

// A test file exercising production code — test → production reachability.
export function testTotal(): boolean {
  return buildDrawing().total() > 0;
}

export function testCircle(): boolean {
  return circleArea(1) > 3;
}
