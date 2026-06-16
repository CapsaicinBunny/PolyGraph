import { describe, expect, test } from "bun:test";
import type { GraphModel, NodeRole } from "../graph/types";
import { analyzeSources } from "./index";

function hasEdge(g: GraphModel, source: string, target: string, kind: string): boolean {
  return g.edges.some((e) => e.source === source && e.target === target && e.kind === kind);
}
function roleOf(g: GraphModel, id: string): NodeRole | undefined {
  return g.nodes.find((n) => n.id === id)?.role;
}
function kindOf(g: GraphModel, id: string): string | undefined {
  return g.nodes.find((n) => n.id === id)?.kind;
}

describe("OOP relationships", () => {
  test("instantiation draws an 'instantiates' edge, not a call", () => {
    const { graph } = analyzeSources({
      "engine.ts": `export class Engine {}`,
      "car.ts": `import { Engine } from "./engine"; export function build() { return new Engine(); }`,
    });
    expect(hasEdge(graph, "car.ts#build", "engine.ts#Engine", "instantiates")).toBe(true);
    expect(hasEdge(graph, "car.ts#build", "engine.ts#Engine", "call")).toBe(false);
  });

  test("composition: a typed field draws a 'has' edge", () => {
    const { graph } = analyzeSources({
      "engine.ts": `export class Engine {}`,
      "car.ts": `import { Engine } from "./engine"; export class Car { private engine!: Engine; }`,
    });
    expect(hasEdge(graph, "car.ts#Car", "engine.ts#Engine", "has")).toBe(true);
  });

  test("composition resolves through arrays and generics", () => {
    const { graph } = analyzeSources({
      "wheel.ts": `export class Wheel {}`,
      "car.ts": `import { Wheel } from "./wheel"; export class Car { wheels: Array<Wheel> = []; }`,
    });
    expect(hasEdge(graph, "car.ts#Car", "wheel.ts#Wheel", "has")).toBe(true);
  });

  test("dependency injection: a constructor param draws an 'injects' edge", () => {
    const { graph } = analyzeSources({
      "logger.ts": `export class Logger {}`,
      "svc.ts": `import { Logger } from "./logger"; export class Service { constructor(private log: Logger) {} }`,
    });
    expect(hasEdge(graph, "svc.ts#Service", "logger.ts#Logger", "injects")).toBe(true);
  });
});

describe("paradigm role detection", () => {
  test("classes named *Component / *System / *Entity get ECS roles", () => {
    const { graph } = analyzeSources({
      "ecs.ts": `
        export class PositionComponent { x = 0; }
        export class MovementSystem { update() {} }
        export class PlayerEntity {}
      `,
    });
    expect(roleOf(graph, "ecs.ts#PositionComponent")).toBe("ecs-component");
    expect(roleOf(graph, "ecs.ts#MovementSystem")).toBe("ecs-system");
    expect(roleOf(graph, "ecs.ts#PlayerEntity")).toBe("ecs-entity");
  });

  test("data-oriented ECS factories create role-tagged variable nodes", () => {
    const { graph } = analyzeSources({
      "world.ts": `
        declare function defineComponent(s: unknown): unknown;
        declare function defineSystem(f: unknown): unknown;
        export const Velocity = defineComponent({ x: "f32" });
        export const Movement = defineSystem(() => {});
      `,
    });
    expect(kindOf(graph, "world.ts#Velocity")).toBe("variable");
    expect(roleOf(graph, "world.ts#Velocity")).toBe("ecs-component");
    expect(roleOf(graph, "world.ts#Movement")).toBe("ecs-system");
    // The camelCase factory functions themselves must NOT be mis-tagged.
    expect(roleOf(graph, "world.ts#defineComponent")).toBeUndefined();
  });

  test("decorator-based ECS is detected", () => {
    const { graph } = analyzeSources({
      "deco.ts": `
        function Component() { return (t: unknown) => t; }
        @Component()
        export class Health {}
      `,
    });
    expect(roleOf(graph, "deco.ts#Health")).toBe("ecs-component");
  });

  test("React components keep the react-component role", () => {
    const { graph } = analyzeSources({
      "App.tsx": `export function App() { return <div />; }`,
    });
    expect(roleOf(graph, "App.tsx#App")).toBe("react-component");
  });
});
