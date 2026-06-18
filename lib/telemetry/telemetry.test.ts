import { describe, expect, test } from "bun:test";
import { Telemetry } from "./telemetry";

function makeConsole() {
  const calls: { level: string; args: unknown[] }[] = [];
  const mk =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  return {
    calls,
    console: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") },
  };
}

// A deterministic clock for time().
function clock(seq: number[]) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

describe("Telemetry", () => {
  test("records events to the log and mirrors to the console when enabled", () => {
    const { calls, console } = makeConsole();
    const t = new Telemetry({ enabled: true, console, now: () => 42 });
    t.event("lod", "cut", { cutSize: 30 });
    const snap = t.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]).toMatchObject({
      t: 42,
      category: "lod",
      event: "cut",
      data: { cutSize: 30 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("info");
  });

  test("disabled is a no-op for event/metric/count", () => {
    const { calls, console } = makeConsole();
    const t = new Telemetry({ enabled: false, console });
    t.event("render", "frame", { ms: 16 });
    t.metric("frame.ms", 16);
    t.count("frames");
    expect(t.snapshot().events).toHaveLength(0);
    expect(t.metrics.counter("frames")).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("time() always runs fn but only records when enabled", () => {
    const off = new Telemetry({ enabled: false });
    expect(off.time("layout", "run", () => 7)).toBe(7); // still returns
    expect(off.metrics.histogram("layout.run.ms").count).toBe(0);

    const on = new Telemetry({ enabled: true, mirror: false, now: clock([100, 130]) });
    const r = on.time("layout", "run", () => "x");
    expect(r).toBe("x");
    expect(on.metrics.histogram("layout.run.ms").summary().max).toBe(30);
  });

  test("metric feeds the rolling histogram", () => {
    const t = new Telemetry({ enabled: true, mirror: false });
    t.metric("lod.computeMs", 5);
    t.metric("lod.computeMs", 15);
    expect(t.metrics.snapshot().histograms["lod.computeMs"].mean).toBe(10);
  });

  test("setEnabled flips behavior; toNDJSON exports the log", () => {
    const t = new Telemetry({ enabled: false, mirror: false });
    t.event("scene", "build"); // dropped
    t.setEnabled(true);
    t.event("scene", "build", { nodes: 3 });
    expect(t.snapshot().events).toHaveLength(1);
    expect(JSON.parse(t.toNDJSON()).data).toEqual({ nodes: 3 });
  });

  test("clearAll empties events and metrics", () => {
    const t = new Telemetry({ enabled: true, mirror: false });
    t.event("lod", "cut");
    t.metric("x", 1);
    t.clearAll();
    expect(t.snapshot().events).toHaveLength(0);
    expect(t.metrics.snapshot().histograms).toEqual({});
  });
});
