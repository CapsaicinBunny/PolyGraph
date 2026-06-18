import { describe, expect, test } from "bun:test";
import { Histogram, Metrics } from "./metrics";

describe("Histogram", () => {
  test("summarizes count/mean/min/max/percentiles", () => {
    const h = new Histogram();
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) h.record(v);
    const s = h.summary();
    expect(s.count).toBe(10);
    expect(s.total).toBe(10);
    expect(s.mean).toBe(5.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.p50).toBe(5); // nearest-rank
    expect(s.p95).toBe(10);
  });

  test("empty histogram is all zeros and NaN percentile", () => {
    const h = new Histogram();
    expect(h.summary()).toEqual({
      count: 0,
      total: 0,
      mean: 0,
      min: 0,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    });
    expect(Number.isNaN(h.percentile(0.5))).toBe(true);
  });

  test("windows to the last N samples but keeps an all-time total", () => {
    const h = new Histogram(3);
    for (const v of [1, 2, 3, 4, 5]) h.record(v); // window holds 3,4,5
    expect(h.count).toBe(3);
    expect(h.total).toBe(5);
    expect(h.summary().min).toBe(3);
    expect(h.summary().max).toBe(5);
  });
});

describe("Metrics", () => {
  test("named histograms are get-or-created and recorded", () => {
    const m = new Metrics();
    m.record("frame.ms", 16);
    m.record("frame.ms", 20);
    expect(m.histogram("frame.ms").count).toBe(2);
    expect(m.snapshot().histograms["frame.ms"].mean).toBe(18);
  });

  test("counters increment", () => {
    const m = new Metrics();
    m.increment("cuts");
    m.increment("cuts", 4);
    expect(m.counter("cuts")).toBe(5);
    expect(m.snapshot().counters.cuts).toBe(5);
  });

  test("reset clears everything", () => {
    const m = new Metrics();
    m.record("a", 1);
    m.increment("b");
    m.reset();
    expect(m.counter("b")).toBe(0);
    expect(m.snapshot().histograms).toEqual({});
  });
});
