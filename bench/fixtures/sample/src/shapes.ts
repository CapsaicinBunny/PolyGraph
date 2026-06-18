import type { Named, Shape } from "./types";
import { circleArea, rectArea } from "./geometry";

export class Circle implements Shape, Named {
  readonly name = "circle";
  constructor(private readonly r: number) {}
  area(): number {
    return circleArea(this.r);
  }
}

export class Rectangle implements Shape, Named {
  readonly name = "rectangle";
  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {}
  area(): number {
    return rectArea(this.w, this.h);
  }
}

// Composition: a Drawing holds Shapes.
export class Drawing {
  private readonly shapes: Shape[] = [];
  add(shape: Shape): void {
    this.shapes.push(shape);
  }
  total(): number {
    return this.shapes.reduce((sum, s) => sum + s.area(), 0);
  }
}
