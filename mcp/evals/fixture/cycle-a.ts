import { b } from "./cycle-b";

export function a(): number {
  return b() + 1;
}
