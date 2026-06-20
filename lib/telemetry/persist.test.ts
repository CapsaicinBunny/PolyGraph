import { describe, expect, test } from "bun:test";
import type { TelemetryEvent } from "./events";
import { eventsSince, flushSessionLog } from "./persist";

const ev = (t: number): TelemetryEvent => ({ t, category: "lod", level: "info", event: "cut" });

describe("eventsSince", () => {
  test("returns only events newer than the cursor", () => {
    const events = [ev(1), ev(2), ev(3), ev(4)];
    expect(eventsSince(events, 2).map((e) => e.t)).toEqual([3, 4]);
  });

  test("returns everything from a -Infinity cursor (first flush)", () => {
    const events = [ev(1), ev(2)];
    expect(eventsSince(events, Number.NEGATIVE_INFINITY)).toHaveLength(2);
  });

  test("returns nothing when the cursor is at or past the newest event", () => {
    const events = [ev(1), ev(2)];
    expect(eventsSince(events, 2)).toHaveLength(0);
    expect(eventsSince([], 5)).toHaveLength(0);
  });
});

describe("flushSessionLog", () => {
  test("is a no-op (does not throw) when persistence never started", () => {
    // The crash paths (ErrorBoundary, global-errors) call this unconditionally; outside Tauri
    // startSessionLogPersist() bails, so the trigger is null and this must quietly do nothing.
    expect(() => flushSessionLog()).not.toThrow();
  });
});
