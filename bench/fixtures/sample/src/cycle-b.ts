import { fromA } from "./cycle-a";

export function fromB(n: number): number {
  return n <= 0 ? 0 : fromA(n - 1);
}
