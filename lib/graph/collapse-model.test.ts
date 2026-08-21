import { describe, expect, test } from "bun:test";
import { type CollapseIntent, compose, type GroupId } from "./collapse-model";

// Tiny helpers so the precedence tests read as data, not Set/Map ceremony.
const intent = (entries: Record<GroupId, "open" | "closed">): CollapseIntent =>
  new Map(Object.entries(entries));
const set = (...ids: GroupId[]): Set<GroupId> => new Set(ids);
const collapsed = (...args: Parameters<typeof compose>) => [...compose(...args)].sort();

describe("compose — precedence (highest-first: closed > open > selection > bootstrap > default)", () => {
  test("default-open: a group with no signal at all is NOT collapsed", () => {
    const out = compose({
      intent: new Map(),
      bootstrapClosed: new Set(),
      selection: new Set(),
    });
    expect(out.size).toBe(0);
  });

  test("bootstrapClosed alone collapses a group (derived safety)", () => {
    expect(
      collapsed({
        intent: new Map(),
        bootstrapClosed: set("directory:a"),
        selection: new Set(),
      }),
    ).toEqual(["directory:a"]);
  });

  test("selection(LOD)-open opens a bootstrap-closed group", () => {
    // The camera/LOD can REVEAL a directory the on-load bootstrap had closed.
    expect(
      collapsed({
        intent: new Map(),
        bootstrapClosed: set("directory:a", "directory:b"),
        selection: set("directory:a"), // a is opened by LOD
      }),
    ).toEqual(["directory:b"]);
  });

  test("selection only opens — it never collapses a group that bootstrap didn't close", () => {
    // selection is a set of OPEN dirs; a group absent from selection AND bootstrap is still default-open.
    expect(
      compose({
        intent: new Map(),
        bootstrapClosed: new Set(),
        selection: set("directory:a"),
      }).size,
    ).toBe(0);
  });

  test("explicit user 'open' beats bootstrapClosed", () => {
    expect(
      compose({
        intent: intent({ "directory:a": "open" }),
        bootstrapClosed: set("directory:a"),
        selection: new Set(),
      }).has("directory:a"),
    ).toBe(false);
  });

  test("explicit user 'closed' beats selection-open (intent wins over the camera)", () => {
    expect(
      collapsed({
        intent: intent({ "directory:a": "closed" }),
        bootstrapClosed: new Set(),
        selection: set("directory:a"), // LOD would open it…
      }),
    ).toEqual(["directory:a"]); // …but the user closed it, so it stays collapsed
  });

  test("explicit user 'closed' beats explicit user 'open' is impossible (one entry per group), but closed always collapses", () => {
    // A single group can only hold one intent value; 'closed' collapses regardless of any
    // selection/bootstrap state.
    expect(
      compose({
        intent: intent({ "directory:a": "closed" }),
        bootstrapClosed: set("directory:a"),
        selection: set("directory:a"),
      }).has("directory:a"),
    ).toBe(true);
  });

  test("a user-'closed' group collapses even with no bootstrap and no selection", () => {
    expect(
      collapsed({
        intent: intent({ "directory:x": "closed" }),
        bootstrapClosed: new Set(),
        selection: new Set(),
      }),
    ).toEqual(["directory:x"]);
  });
});

describe("compose — reverting intent reverts to auto", () => {
  test("deleting a 'closed' intent entry reverts the group to its auto (bootstrap) state", () => {
    const bootstrapClosed = set("directory:a");
    // With intent closed AND bootstrap closed → collapsed.
    const withIntent = intent({ "directory:a": "closed" });
    expect(
      compose({ intent: withIntent, bootstrapClosed, selection: new Set() }).has("directory:a"),
    ).toBe(true);
    // Remove the intent entry → falls back to bootstrap (still closed here).
    withIntent.delete("directory:a");
    expect(
      compose({ intent: withIntent, bootstrapClosed, selection: new Set() }).has("directory:a"),
    ).toBe(true);
  });

  test("deleting an 'open' intent entry reverts the group to auto — re-collapsing if bootstrap closed it", () => {
    const bootstrapClosed = set("directory:a");
    const withOpen = intent({ "directory:a": "open" });
    // Intent open beats bootstrap → not collapsed.
    expect(
      compose({ intent: withOpen, bootstrapClosed, selection: new Set() }).has("directory:a"),
    ).toBe(false);
    // Remove it → bootstrap closed wins again.
    withOpen.delete("directory:a");
    expect(
      compose({ intent: withOpen, bootstrapClosed, selection: new Set() }).has("directory:a"),
    ).toBe(true);
  });

  test("deleting an 'open' intent entry on a default-open group leaves it open (no bootstrap to fall back to)", () => {
    const withOpen = intent({ "directory:a": "open" });
    withOpen.delete("directory:a");
    expect(
      compose({ intent: withOpen, bootstrapClosed: new Set(), selection: new Set() }).size,
    ).toBe(0);
  });
});

describe("compose — purity & inputs are not mutated", () => {
  test("does not mutate the intent map, bootstrap set, or selection set", () => {
    const i = intent({ "directory:a": "closed" });
    const b = set("directory:b");
    const s = set("directory:c");
    compose({ intent: i, bootstrapClosed: b, selection: s });
    expect([...i.entries()]).toEqual([["directory:a", "closed"]]);
    expect([...b]).toEqual(["directory:b"]);
    expect([...s]).toEqual(["directory:c"]);
  });

  test("returns a fresh Set each call (callers may freely mutate the result)", () => {
    const a = compose({
      intent: intent({ "directory:a": "closed" }),
      bootstrapClosed: new Set(),
      selection: new Set(),
    });
    const b = compose({
      intent: intent({ "directory:a": "closed" }),
      bootstrapClosed: new Set(),
      selection: new Set(),
    });
    expect(a).not.toBe(b);
  });
});

describe("compose — single-id maximal overlap (the full precedence ladder on ONE group)", () => {
  // The combined-scenario test below spreads the signals across DIFFERENT ids. These pin
  // the ladder when intent + bootstrap + selection all land on the SAME group, so a future
  // reorder of the layers can't silently change a per-group resolution.
  test("intent 'open' + bootstrap-closed + selected → open (user-open is top, others moot)", () => {
    expect(
      compose({
        intent: intent({ "directory:a": "open" }),
        bootstrapClosed: set("directory:a"),
        selection: set("directory:a"),
      }).has("directory:a"),
    ).toBe(false);
  });

  test("intent 'closed' + bootstrap-closed + selected → collapsed (user-closed is top, selection cannot release)", () => {
    expect(
      collapsed({
        intent: intent({ "directory:a": "closed" }),
        bootstrapClosed: set("directory:a"),
        selection: set("directory:a"),
      }),
    ).toEqual(["directory:a"]);
  });
});

describe("compose — combined scenarios", () => {
  test("mix of all five layers resolves each group by its highest-precedence signal", () => {
    const out = collapsed({
      intent: intent({
        "directory:closedByUser": "closed",
        "directory:openByUser": "open",
      }),
      bootstrapClosed: set(
        "directory:openByUser", // overridden by user-open
        "directory:closedByBootstrap", // no other signal → collapsed
        "directory:openedByLod", // opened by selection
        "directory:closedByUser", // already user-closed
      ),
      selection: set("directory:openedByLod", "directory:defaultOpen"),
    });
    expect(out).toEqual(["directory:closedByBootstrap", "directory:closedByUser"]);
  });
});
