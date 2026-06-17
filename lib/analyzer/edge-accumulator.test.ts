import { describe, expect, test } from "bun:test";
import type { EdgeEvidence } from "../graph/types";
import { EdgeBuilder } from "./edge-accumulator";

const ev = (line: number, overrides: Partial<EdgeEvidence> = {}): EdgeEvidence => ({
  filePath: "a.ts",
  line,
  column: 1,
  provider: "TypeScript",
  confidence: "exact",
  ...overrides,
});

describe("EdgeBuilder", () => {
  test("caps occurrences at 25 but keeps an exact count", () => {
    const b = new EdgeBuilder();
    for (let i = 0; i < 30; i++) {
      b.add("a.ts#foo", "b.ts#bar", "call", ev(i + 1));
    }
    const edges = b.build();
    expect(edges).toHaveLength(1);
    expect(edges[0].occurrences.length).toBe(25);
    expect(edges[0].count).toBe(30);
  });

  test("dedupes identical evidence entirely (no count, no push)", () => {
    const b = new EdgeBuilder();
    b.add("a.ts#foo", "b.ts#bar", "call", ev(7));
    b.add("a.ts#foo", "b.ts#bar", "call", ev(7));
    const edges = b.build();
    expect(edges).toHaveLength(1);
    expect(edges[0].count).toBe(1);
    expect(edges[0].occurrences.length).toBe(1);
  });

  test("distinct kinds between the same endpoints produce separate edges", () => {
    const b = new EdgeBuilder();
    b.add("a.ts#foo", "b.ts#bar", "call", ev(1));
    b.add("a.ts#foo", "b.ts#bar", "instantiates", ev(2));
    const edges = b.build();
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.kind))).toEqual(new Set(["call", "instantiates"]));
  });

  test("drops self-edges", () => {
    const b = new EdgeBuilder();
    b.add("a.ts#foo", "a.ts#foo", "call", ev(1));
    expect(b.build()).toHaveLength(0);
  });
});
