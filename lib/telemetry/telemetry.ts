// The telemetry bus: one place the whole app records structured events + rolling
// metrics. Disabled → every method is a near-zero-cost no-op (a single boolean
// check), so instrumentation can live on hot paths (per-frame, per-cut) safely.
// Enabled → events go to a ring buffer and are mirrored to the console; metrics
// feed rolling histograms. The buffer is exportable as NDJSON (the session log).

import { type Category, type Level, TelemetryEvent, TelemetryLog } from "./events";
import { Metrics } from "./metrics";

const STORAGE_KEY = "polygraph.telemetry";

interface ConsoleLike {
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

export interface TelemetryOptions {
  capacity?: number;
  /** Clock, injectable for deterministic tests. */
  now?: () => number;
  /** Console sink, injectable for tests. */
  console?: ConsoleLike;
  /** Force initial enabled state (else read localStorage, default true). */
  enabled?: boolean;
  /** Mirror events to the console when enabled (default true). */
  mirror?: boolean;
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function readPersistedEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v !== "off"; // default on; only "off" disables
  } catch {
    return true;
  }
}

export class Telemetry {
  readonly log: TelemetryLog;
  readonly metrics = new Metrics();
  private enabled: boolean;
  private readonly now: () => number;
  private readonly sink: ConsoleLike;
  private readonly mirror: boolean;

  constructor(opts: TelemetryOptions = {}) {
    this.log = new TelemetryLog(opts.capacity);
    this.now = opts.now ?? defaultNow;
    this.sink = opts.console ?? (globalThis.console as ConsoleLike);
    this.mirror = opts.mirror ?? true;
    this.enabled = opts.enabled ?? readPersistedEnabled();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable/disable and persist the choice. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      /* ignore unavailable storage */
    }
  }

  /** Record a structured event (no-op when disabled). */
  event(
    category: Category,
    event: string,
    data?: Record<string, unknown>,
    level: Level = "info",
  ): void {
    if (!this.enabled) return;
    const e: TelemetryEvent = { t: this.now(), category, level, event, ...(data ? { data } : {}) };
    this.log.push(e);
    if (this.mirror) this.sink[level](`[${category}] ${event}`, data ?? "");
  }

  /** Record a value into a named rolling histogram (no-op when disabled). */
  metric(name: string, value: number): void {
    if (!this.enabled) return;
    this.metrics.record(name, value);
  }

  /** Increment a named counter (no-op when disabled). */
  count(name: string, by = 1): void {
    if (!this.enabled) return;
    this.metrics.increment(name, by);
  }

  /**
   * Time a synchronous function, recording the duration into `metric` (and an
   * event). Always runs `fn`; only the recording is gated.
   */
  time<T>(category: Category, event: string, fn: () => T, metricName?: string): T {
    if (!this.enabled) return fn();
    const start = this.now();
    const result = fn();
    const ms = this.now() - start;
    this.metric(metricName ?? `${category}.${event}.ms`, ms);
    this.event(category, event, { ms }, "debug");
    return result;
  }

  /** How many events are currently buffered (for the Settings "download" hint). */
  eventCount(): number {
    return this.log.size;
  }

  snapshot() {
    return { enabled: this.enabled, events: this.log.snapshot(), metrics: this.metrics.snapshot() };
  }

  /** The session log as NDJSON (one event per line). */
  toNDJSON(): string {
    return this.log.toNDJSON();
  }

  clearAll(): void {
    this.log.clear();
    this.metrics.reset();
  }
}

/** Process-wide singleton used by the app's instrumentation hooks. */
export const telemetry = new Telemetry();
