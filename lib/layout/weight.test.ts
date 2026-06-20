import { describe, expect, test } from "bun:test";
import { edgeWeight, relationshipWeight } from "./weight";

describe("relationshipWeight", () => {
  test("ranks structural/architectural relationships above incidental ones", () => {
    // extends/implements (inheritance) are the strongest architectural signal;
    // call is the weakest (incidental). This ordering is the whole point.
    expect(relationshipWeight("extends")).toBe(8);
    expect(relationshipWeight("implements")).toBe(8);
    expect(relationshipWeight("injects")).toBe(6);
    expect(relationshipWeight("has")).toBe(5);
    expect(relationshipWeight("import")).toBe(4);
    expect(relationshipWeight("renders")).toBe(3);
    expect(relationshipWeight("instantiates")).toBe(2);
    expect(relationshipWeight("call")).toBe(1);
  });

  test("structural 'contains' edges carry no layout weight", () => {
    // "contains" is the synthetic file→symbol nesting edge; it must not pull layout.
    expect(relationshipWeight("contains")).toBe(0);
  });
});

describe("edgeWeight", () => {
  test("scales the base weight by log2(1 + count)", () => {
    // count 1 → log2(2) = 1 (no boost); count 3 → log2(4) = 2 (doubled).
    expect(edgeWeight("call", 1)).toBe(1);
    expect(edgeWeight("extends", 3)).toBe(16);
  });

  test("a single inheritance edge outweighs a hundred incidental calls", () => {
    // The reason for log-scaling: thousands of calls must not bury one 'extends'.
    expect(edgeWeight("extends", 1)).toBeGreaterThan(edgeWeight("call", 100));
  });

  test("a zero/absent count never produces NaN or negative weight", () => {
    expect(edgeWeight("import", 0)).toBe(0);
    expect(edgeWeight("contains", 5)).toBe(0);
  });
});
