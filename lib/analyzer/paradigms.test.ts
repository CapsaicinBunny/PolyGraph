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

  test("data-oriented ECS factories create role-tagged variable nodes (bitecs context)", () => {
    const { graph } = analyzeSources({
      "world.ts": `
        import { defineComponent, defineSystem } from "bitecs";
        export const Velocity = defineComponent({ x: "f32" });
        export const Movement = defineSystem(() => {});
      `,
    });
    expect(kindOf(graph, "world.ts#Velocity")).toBe("variable");
    // bitecs import => defineComponent is an ECS component, not Vue.
    expect(roleOf(graph, "world.ts#Velocity")).toBe("ecs-component");
    expect(roleOf(graph, "world.ts#Movement")).toBe("ecs-system");
  });

  test("lowercase @component decorator is ECS", () => {
    const { graph } = analyzeSources({
      "deco.ts": `
        function component() { return (t: unknown) => t; }
        @component()
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

describe("multi-framework detection", () => {
  test("Angular decorators map to angular roles", () => {
    const { graph } = analyzeSources({
      "app.ts": `
        import { Component, Injectable, NgModule } from "@angular/core";
        @Component({ selector: "app" }) export class AppComponent {}
        @Injectable() export class DataService {}
        @NgModule({}) export class AppModule {}
      `,
    });
    expect(roleOf(graph, "app.ts#AppComponent")).toBe("angular-component");
    expect(roleOf(graph, "app.ts#DataService")).toBe("angular-service");
    expect(roleOf(graph, "app.ts#AppModule")).toBe("angular-module");
  });

  test("defineComponent in a Vue file is a Vue component", () => {
    const { graph } = analyzeSources({
      "Hello.ts": `
        import { defineComponent } from "vue";
        export const Hello = defineComponent({ name: "Hello" });
      `,
    });
    expect(roleOf(graph, "Hello.ts#Hello")).toBe("vue-component");
  });

  test(".vue single-file component: file is a Vue component and its <script> is analyzed", () => {
    const { graph } = analyzeSources({
      "Counter.vue": `<template><button @click="inc">{{ n }}</button></template>
<script setup lang="ts">
import { ref } from "vue";
const n = ref(0);
function inc() { n.value++; }
</script>`,
    });
    expect(roleOf(graph, "Counter.vue")).toBe("vue-component");
    // The embedded script is parsed as TS, so inner declarations become nodes.
    expect(kindOf(graph, "Counter.vue#inc")).toBe("function");
  });

  test(".svelte file is a Svelte component", () => {
    const { graph } = analyzeSources({
      "Box.svelte": `<script lang="ts">export let label: string;</script><div>{label}</div>`,
    });
    expect(roleOf(graph, "Box.svelte")).toBe("svelte-component");
  });
});
