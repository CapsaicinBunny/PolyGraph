import { describe, expect, test } from "bun:test";
import { detectCommunities } from "./community";

const E = (source: string, target: string) => ({ source, target });

describe("detectCommunities", () => {
  test("two cliques become two communities", () => {
    // {a,b,c} densely connected; {x,y,z} densely connected; one bridge.
    const ids = ["a", "b", "c", "x", "y", "z"];
    const edges = [
      E("a", "b"),
      E("b", "c"),
      E("a", "c"),
      E("x", "y"),
      E("y", "z"),
      E("x", "z"),
      E("c", "x"), // weak bridge
    ];
    const comm = detectCommunities(ids, edges);
    // a,b,c share a community; x,y,z share a community; the two differ.
    expect(comm.get("a")).toBe(comm.get("b"));
    expect(comm.get("a")).toBe(comm.get("c"));
    expect(comm.get("x")).toBe(comm.get("y"));
    expect(comm.get("x")).toBe(comm.get("z"));
    expect(comm.get("a")).not.toBe(comm.get("x"));
  });

  test("a chain stays one community (no bipartite 2-coloring)", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const comm = detectCommunities(ids, [
      E("a", "b"),
      E("b", "c"),
      E("c", "d"),
      E("d", "e"),
      E("e", "f"),
    ]);
    const labels = new Set(ids.map((id) => comm.get(id)));
    expect(labels.size).toBe(1);
  });

  test("a star (hub + leaves) is one community", () => {
    const comm = detectCommunities(
      ["hub", "l1", "l2", "l3", "l4"],
      [E("hub", "l1"), E("hub", "l2"), E("hub", "l3"), E("hub", "l4")],
    );
    expect(comm.get("l1")).toBe(comm.get("hub"));
    expect(comm.get("l4")).toBe(comm.get("hub"));
  });

  test("isolated nodes get their own community each", () => {
    const comm = detectCommunities(["p", "q"], []);
    expect(comm.get("p")).not.toBe(comm.get("q"));
  });

  test("community ids are 'Community N' numbered by sorted appearance", () => {
    const comm = detectCommunities(["b", "a"], []);
    expect(comm.get("a")).toBe("Community 1"); // 'a' sorts first
    expect(comm.get("b")).toBe("Community 2");
  });

  test("is deterministic regardless of input order", () => {
    const ids1 = ["a", "b", "c"];
    const ids2 = ["c", "a", "b"];
    const e1 = [E("a", "b"), E("b", "c")];
    const e2 = [E("b", "c"), E("a", "b")];
    expect([...detectCommunities(ids1, e1).entries()]).toEqual([
      ...detectCommunities(ids2, e2).entries(),
    ]);
  });
});
