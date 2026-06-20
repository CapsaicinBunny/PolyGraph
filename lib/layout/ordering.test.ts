import { describe, expect, test } from "bun:test";
import {
  barycenterValue,
  edgeKey,
  fiedlerOrder,
  orderByBarycenter,
  rcmOrder,
  stableOrder,
  undirectedKey,
} from "./ordering";

const E = (source: string, target: string) => ({ source, target });

describe("rcmOrder (Reverse Cuthill–McKee)", () => {
  test("orders a path so connected nodes stay adjacent", () => {
    // Path a-b-c-d-e. Min-degree start is "a"; CM walks the path, RCM reverses it.
    const order = rcmOrder(
      ["a", "b", "c", "d", "e"],
      [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")],
    );
    expect(order).toEqual(["e", "d", "c", "b", "a"]);
  });

  test("keeps each disconnected component contiguous", () => {
    // Two separate edges: {a-b} and {c-d}. Neither component interleaves the other.
    const order = rcmOrder(["a", "b", "c", "d"], [E("a", "b"), E("c", "d")]);
    const ai = order.indexOf("a");
    const bi = order.indexOf("b");
    const ci = order.indexOf("c");
    const di = order.indexOf("d");
    expect(Math.abs(ai - bi)).toBe(1);
    expect(Math.abs(ci - di)).toBe(1);
    expect(order.slice().sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("is deterministic regardless of input order", () => {
    const a = rcmOrder(["c", "a", "b"], [E("b", "c"), E("a", "b")]);
    const b = rcmOrder(["a", "b", "c"], [E("a", "b"), E("b", "c")]);
    expect(a).toEqual(b);
  });

  test("returns isolated nodes by stable id order", () => {
    expect(rcmOrder(["y", "x"], [])).toEqual(["x", "y"]);
  });
});

describe("fiedlerOrder (spectral / Fiedler vector)", () => {
  test("recovers the linear order of a path", () => {
    // The Fiedler vector of a path is monotonic, so ordering by it recovers the path.
    // Sign is canonicalized (first id < last id) so the orientation is deterministic.
    const order = fiedlerOrder(
      ["a", "b", "c", "d", "e"],
      [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")],
    );
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("keeps two clusters contiguous (separates along the Fiedler cut)", () => {
    // Two triangles joined by a single bridge c-d. The Fiedler vector splits them,
    // so each triangle should occupy a contiguous run of three positions.
    const order = fiedlerOrder(
      ["a", "b", "c", "d", "e", "f"],
      [E("a", "b"), E("b", "c"), E("c", "a"), E("d", "e"), E("e", "f"), E("f", "d"), E("c", "d")],
    );
    const span = (ids: string[]) => {
      const idx = ids.map((i) => order.indexOf(i));
      return Math.max(...idx) - Math.min(...idx);
    };
    expect(span(["a", "b", "c"])).toBe(2);
    expect(span(["d", "e", "f"])).toBe(2);
  });

  test("is deterministic regardless of input order", () => {
    const a = fiedlerOrder(["c", "a", "b", "d"], [E("a", "b"), E("b", "c"), E("c", "d")]);
    const b = fiedlerOrder(["d", "c", "b", "a"], [E("d", "c"), E("c", "b"), E("b", "a")]);
    expect(a).toEqual(b);
  });

  test("orders isolated nodes by stable id", () => {
    expect(fiedlerOrder(["y", "x"], [])).toEqual(["x", "y"]);
  });
});

describe("stableOrder (deterministic tie-break stack)", () => {
  test("falls back to directory then id when no metadata is given", () => {
    // "x" and "y" dirs group; within a dir, by path/id.
    expect(stableOrder(["y/1", "x/2", "x/1"], {})).toEqual(["x/1", "x/2", "y/1"]);
    expect(stableOrder(["b", "a", "c"], {})).toEqual(["a", "b", "c"]);
  });

  test("previous position dominates id (mental-map stability)", () => {
    const previousIndex = new Map([
      ["a", 2],
      ["b", 0],
      ["c", 1],
    ]);
    expect(stableOrder(["a", "b", "c"], { previousIndex })).toEqual(["b", "c", "a"]);
  });

  test("new nodes (no previous position) sort after known ones", () => {
    const previousIndex = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    expect(stableOrder(["a", "b", "new"], { previousIndex })).toEqual(["a", "b", "new"]);
  });

  test("community groups outrank id", () => {
    const community = new Map([
      ["a", "C2"],
      ["b", "C1"],
      ["c", "C1"],
    ]);
    expect(stableOrder(["a", "b", "c"], { community })).toEqual(["b", "c", "a"]);
  });

  test("pinned nodes come first", () => {
    expect(stableOrder(["a", "b", "c"], { pinned: new Set(["c"]) })).toEqual(["c", "a", "b"]);
  });

  test("is a pure stable sort (input order does not matter)", () => {
    const community = new Map([
      ["a", "C1"],
      ["b", "C2"],
      ["c", "C1"],
    ]);
    expect(stableOrder(["c", "b", "a"], { community })).toEqual(
      stableOrder(["a", "b", "c"], { community }),
    );
  });
});

describe("barycenter ordering (layered/radial crossing reduction)", () => {
  test("barycenterValue is the weight-weighted average of neighbor positions", () => {
    expect(
      barycenterValue([
        { pos: 0, weight: 1 },
        { pos: 4, weight: 3 },
      ]),
    ).toBe(3);
    expect(barycenterValue([])).toBeNull();
  });

  test("reorders a layer toward its neighbors' positions (fewer crossings)", () => {
    // b's only neighbor sits at position 1, a's at position 0 → a should come first.
    const order = orderByBarycenter(["b", "a"], (id) =>
      id === "b" ? [{ pos: 1, weight: 1 }] : [{ pos: 0, weight: 1 }],
    );
    expect(order).toEqual(["a", "b"]);
  });

  test("keeps a node with no neighbors in its relative slot", () => {
    // Only "mid" has a neighbor (far left); the neighborless ends keep their order.
    const order = orderByBarycenter(["left", "mid", "right"], (id) =>
      id === "mid" ? [{ pos: 0, weight: 1 }] : [],
    );
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("right"));
  });
});

describe("edgeKey / undirectedKey (collision-free)", () => {
  test("distinct id pairs never alias", () => {
    expect(edgeKey("ab", "c")).not.toBe(edgeKey("a", "bc"));
    expect(edgeKey("a", "b")).not.toBe(edgeKey("b", "a")); // directed: order matters
  });
  test("undirectedKey is order-independent but still collision-free", () => {
    expect(undirectedKey("a", "b")).toBe(undirectedKey("b", "a"));
    expect(undirectedKey("ab", "c")).not.toBe(undirectedKey("a", "bc"));
  });
});
