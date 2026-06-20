import { describe, expect, test } from "bun:test";
import { coreness } from "./backbone";

const E = (source: string, target: string) => ({ source, target });

describe("coreness (k-core decomposition)", () => {
  test("a triangle is a 2-core", () => {
    const c = coreness(["a", "b", "c"], [E("a", "b"), E("b", "c"), E("c", "a")]);
    expect(c.get("a")).toBe(2);
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(2);
  });

  test("a path is a 1-core throughout", () => {
    const c = coreness(["a", "b", "c", "d"], [E("a", "b"), E("b", "c"), E("c", "d")]);
    expect([...c.values()].every((v) => v === 1)).toBe(true);
  });

  test("a star is a 1-core (the hub does not raise coreness)", () => {
    const c = coreness(["h", "a", "b", "c"], [E("h", "a"), E("h", "b"), E("h", "c")]);
    expect(c.get("h")).toBe(1);
    expect(c.get("a")).toBe(1);
  });

  test("separates a dense core from its leaves", () => {
    // Triangle a,b,c (2-core) with a leaf d hanging off a (1-core).
    const c = coreness(["a", "b", "c", "d"], [E("a", "b"), E("b", "c"), E("c", "a"), E("a", "d")]);
    expect(c.get("a")).toBe(2);
    expect(c.get("d")).toBe(1);
  });

  test("isolated nodes are a 0-core", () => {
    const c = coreness(["x", "y"], []);
    expect(c.get("x")).toBe(0);
  });

  test("is deterministic regardless of input order", () => {
    const a = coreness(["c", "a", "b"], [E("b", "c"), E("a", "b"), E("c", "a")]);
    const b = coreness(["a", "b", "c"], [E("a", "b"), E("b", "c"), E("c", "a")]);
    expect(a).toEqual(b); // Maps compare structurally (order-independent)
  });
});
