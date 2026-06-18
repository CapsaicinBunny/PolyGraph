import { describe, expect, test } from "bun:test";
import { TelemetryLog, type TelemetryEvent } from "./events";

const ev = (i: number): TelemetryEvent => ({
  t: i,
  category: "lod",
  level: "info",
  event: `e${i}`,
});

describe("TelemetryLog", () => {
  test("retains events in chronological order under capacity", () => {
    const log = new TelemetryLog(10);
    for (let i = 0; i < 3; i++) log.push(ev(i));
    expect(log.size).toBe(3);
    expect(log.snapshot().map((e) => e.event)).toEqual(["e0", "e1", "e2"]);
  });

  test("overwrites oldest when full (ring), keeping the most recent N in order", () => {
    const log = new TelemetryLog(3);
    for (let i = 0; i < 5; i++) log.push(ev(i)); // e0..e4
    expect(log.size).toBe(3);
    expect(log.snapshot().map((e) => e.event)).toEqual(["e2", "e3", "e4"]);
  });

  test("toNDJSON emits one JSON object per line in order", () => {
    const log = new TelemetryLog(5);
    log.push(ev(0));
    log.push(ev(1));
    const lines = log.toNDJSON().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("e0");
    expect(JSON.parse(lines[1]).t).toBe(1);
  });

  test("clear resets the buffer", () => {
    const log = new TelemetryLog(3);
    log.push(ev(0));
    log.clear();
    expect(log.size).toBe(0);
    expect(log.snapshot()).toEqual([]);
  });
});
