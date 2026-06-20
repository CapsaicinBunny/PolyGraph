import { describe, expect, test } from "bun:test";
import {
  buildAdjacency,
  connectionHighlight,
  connectionPath,
  connectionRoles,
  connectionStatus,
  nextAnchors,
  pairKey,
  pruneAnchors,
} from "./connections";

const E = (source: string, target: string) => ({ source, target });
// a - b - c - d  (a chain), plus an isolated card "x"
const adj = buildAdjacency([E("a", "b"), E("b", "c"), E("c", "d")]);

describe("buildAdjacency", () => {
  test("is undirected and drops self-loops", () => {
    const a = buildAdjacency([E("a", "b"), E("z", "z")]);
    expect([...(a.get("a") ?? [])]).toEqual(["b"]);
    expect([...(a.get("b") ?? [])]).toEqual(["a"]);
    expect(a.has("z")).toBe(false);
  });

  test("drops containment edges so paths run through code, not the folder tree", () => {
    // dir -contains-> a, dir -contains-> b: a and b share a folder but have no code relation,
    // so they must NOT be connected through the containment hub.
    const a = buildAdjacency([
      { source: "dir", target: "a", kind: "contains" },
      { source: "dir", target: "b", kind: "contains" },
      { source: "a", target: "c", kind: "import" },
    ]);
    expect(a.has("dir")).toBe(false);
    expect(connectionPath("a", "b", a)).toBeNull();
    expect(connectionPath("a", "c", a)).toEqual(["a", "c"]);
  });
});

describe("nextAnchors (click state machine)", () => {
  test("plain click → only that card", () => {
    expect(nextAnchors([], "a", false)).toEqual(["a"]);
    expect(nextAnchors(["a", "b"], "c", false)).toEqual(["c"]);
  });
  test("plain click on the sole anchor keeps the same reference (no churn)", () => {
    const prev = ["a"];
    expect(nextAnchors(prev, "a", false)).toBe(prev);
  });
  test("shift with no anchor establishes the first endpoint", () => {
    expect(nextAnchors([], "a", true)).toEqual(["a"]);
  });
  test("shift with one anchor (different card) sets the second endpoint", () => {
    expect(nextAnchors(["a"], "b", true)).toEqual(["a", "b"]);
  });
  test("shift on the same single anchor is a no-op (no zero-step path)", () => {
    const prev = ["a"];
    expect(nextAnchors(prev, "a", true)).toBe(prev);
  });
  test("shift after a full path starts a fresh path from the clicked card", () => {
    expect(nextAnchors(["a", "b"], "c", true)).toEqual(["c"]);
  });
});

describe("pruneAnchors (stale anchors after LOD/collapse)", () => {
  test("removes anchors whose card left the scene", () => {
    expect(pruneAnchors(["a", "b"], new Set(["b"]))).toEqual(["b"]);
    expect(pruneAnchors(["a", "b"], new Set(["x"]))).toEqual([]);
  });
  test("returns the same reference when nothing changed", () => {
    const prev = ["a", "b"];
    expect(pruneAnchors(prev, new Set(["a", "b"]))).toBe(prev);
  });
});

describe("connectionStatus (non-directional label)", () => {
  const id = (s: string) => s;
  test("two connected anchors → an undirected label with step count (no arrow)", () => {
    const h = connectionHighlight(["a", "d"], adj);
    const s = connectionStatus(["a", "d"], h, id);
    expect(s?.ok).toBe(true);
    expect(s?.text).toBe("a ⇄ d · 3 steps");
    expect(s?.text).not.toContain("→"); // must not imply dependency direction
  });
  test("one step is singular", () => {
    const h = connectionHighlight(["a", "b"], adj);
    expect(connectionStatus(["a", "b"], h, id)?.text).toBe("a ⇄ b · 1 step");
  });
  test("unconnected anchors → a 'no connection' notice, not an arrow", () => {
    const h = connectionHighlight(["a", "x"], adj);
    const s = connectionStatus(["a", "x"], h, id);
    expect(s?.ok).toBe(false);
    expect(s?.text).toBe("No connection between a and x");
  });
  test("null for fewer than two anchors", () => {
    expect(connectionStatus(["a"], connectionHighlight(["a"], adj), id)).toBeNull();
  });
});

describe("connectionPath (undirected shortest path)", () => {
  test("finds the shortest path inclusive of endpoints", () => {
    expect(connectionPath("a", "d", adj)).toEqual(["a", "b", "c", "d"]);
  });
  test("returns [node] for the same endpoint", () => {
    expect(connectionPath("b", "b", adj)).toEqual(["b"]);
  });
  test("returns null when there is no path", () => {
    expect(connectionPath("a", "x", adj)).toBeNull();
  });
});

describe("connectionHighlight", () => {
  const sorted = (s?: Set<string>) => [...(s ?? [])].sort();

  test("returns null for no anchors", () => {
    expect(connectionHighlight([], adj)).toBeNull();
  });

  test("one anchor → the card plus its direct neighbors", () => {
    const h = connectionHighlight(["b"], adj);
    expect(h?.connected).toBe(true);
    expect(sorted(h?.nodeIds)).toEqual(["a", "b", "c"]);
  });

  test("two connected anchors → the full path between them", () => {
    const h = connectionHighlight(["a", "d"], adj);
    expect(h?.connected).toBe(true);
    expect(sorted(h?.nodeIds)).toEqual(["a", "b", "c", "d"]);
    expect(h?.path).toEqual(["a", "b", "c", "d"]);
  });

  test("two unconnected anchors → not connected, just the two cards lit, no edges", () => {
    const h = connectionHighlight(["a", "x"], adj);
    expect(h?.connected).toBe(false);
    expect(sorted(h?.nodeIds)).toEqual(["a", "x"]);
    expect(h?.edgePairs.size).toBe(0);
  });

  test("triangle, one anchor: only the anchor's edges light, NOT the neighbor↔neighbor chord", () => {
    // A connected to B and C; B—C is a chord between two lit neighbors.
    const tri = buildAdjacency([E("A", "B"), E("A", "C"), E("B", "C")]);
    const h = connectionHighlight(["A"], tri);
    expect(sorted(h?.nodeIds)).toEqual(["A", "B", "C"]);
    expect(h?.edgePairs.has(pairKey("A", "B"))).toBe(true);
    expect(h?.edgePairs.has(pairKey("A", "C"))).toBe(true);
    expect(h?.edgePairs.has(pairKey("B", "C"))).toBe(false); // the chord must stay dim
  });

  test("path: edgePairs are exactly the consecutive path edges", () => {
    const h = connectionHighlight(["a", "d"], adj); // a-b-c-d
    expect(sorted(h?.edgePairs)).toEqual(
      [pairKey("a", "b"), pairKey("b", "c"), pairKey("c", "d")].sort(),
    );
  });

  test("path skipping a node via a chord lights only the chosen path's edges", () => {
    // a-b-c-d-e linear plus a b—d chord → shortest a→e is a-b-d-e (skips c).
    const g = buildAdjacency([E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e"), E("b", "d")]);
    const h = connectionHighlight(["a", "e"], g);
    expect(h?.path).toEqual(["a", "b", "d", "e"]);
    expect(h?.nodeIds.has("c")).toBe(false); // c is skipped, must dim
    expect(h?.edgePairs.has(pairKey("b", "c"))).toBe(false);
    expect(h?.edgePairs.has(pairKey("c", "d"))).toBe(false);
  });

  test("parallel relationship kinds between the same two cards share one pairKey", () => {
    // Multiple scene edges A↔B (e.g. import + call) collapse to one undirected pair, so the
    // canvas lights all of them when A—B is a connection edge.
    const g = buildAdjacency([
      { source: "A", target: "B", kind: "import" },
      { source: "A", target: "B", kind: "call" },
    ]);
    const h = connectionHighlight(["A"], g);
    expect(h?.edgePairs.has(pairKey("A", "B"))).toBe(true);
    expect(h?.edgePairs.has(pairKey("B", "A"))).toBe(true); // order-independent
  });
});

describe("connectionRoles (outline ring roles)", () => {
  test("no highlight → empty map", () => {
    expect(connectionRoles(["a"], null).size).toBe(0);
    expect(connectionRoles([], connectionHighlight([], adj)).size).toBe(0);
  });

  test("one anchor → just a start", () => {
    const roles = connectionRoles(["b"], connectionHighlight(["b"], adj));
    expect(roles.get("b")).toBe("start");
    expect([...roles.values()].filter((r) => r === "start")).toHaveLength(1);
  });

  test("two connected anchors → start, end, and the middles as path", () => {
    const roles = connectionRoles(["a", "d"], connectionHighlight(["a", "d"], adj)); // a-b-c-d
    expect(roles.get("a")).toBe("start");
    expect(roles.get("d")).toBe("end");
    expect(roles.get("b")).toBe("path");
    expect(roles.get("c")).toBe("path");
  });

  test("two unconnected anchors → start and end, no path nodes", () => {
    const roles = connectionRoles(["a", "x"], connectionHighlight(["a", "x"], adj));
    expect(roles.get("a")).toBe("start");
    expect(roles.get("x")).toBe("end");
    expect([...roles.values()].some((r) => r === "path")).toBe(false);
  });
});
