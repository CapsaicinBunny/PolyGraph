import { fromB } from "./cycle-b";

export function fromA(n: number): number {
  return n <= 0 ? 0 : fromB(n - 1);
}
