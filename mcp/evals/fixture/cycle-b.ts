import { a } from "./cycle-a";

export function b(): number {
  return a() - 1;
}
