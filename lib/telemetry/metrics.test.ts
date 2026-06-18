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

  test("percentiles stay correct after the ring wraps (order-independent)", () => {
    // Descending input so the kept window {5,4,3,2,1} is stored ring-rotated, not sorted.
    const h = new Histogram(5);
    for (const v of [9, 8, 7, 6, 5, 4, 3, 2, 1]) h.record(v);
    expect(h.count).toBe(5);
    expect(h.total).toBe(9);
    const s = h.summary();
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p50).toBe(3); // nearest-rank of {1,2,3,4,5}
    expect(h.percentile(1)).toBe(5);
  });

  test("single-sample and small-N percentiles clamp instead of over-indexing", () => {
    const one = new Histogram();
    one.record(42);
    expect(one.summary()).toMatchObject({ count: 1, p50: 42, p95: 42, p99: 42 });
    const few = new Histogram();
    for (const v of [10, 20, 30]) few.record(v);
    expect(few.summary()).toMatchObject({ p50: 20, p95: 30, p99: 30 });
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
