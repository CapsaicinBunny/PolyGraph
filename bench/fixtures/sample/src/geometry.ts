export function square(n: number): number {
  return n * n;
}

export function circleArea(r: number): number {
  return Math.PI * square(r);
}

export function rectArea(w: number, h: number): number {
  return w * h;
}
