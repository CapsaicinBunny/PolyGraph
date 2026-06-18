// Structured telemetry events + a bounded ring buffer. The buffer keeps the most
// recent N events (oldest overwritten) so a long session can't grow memory, and
// snapshots them in chronological order for the downloadable log. Pure.

export type Category = "analysis" | "layout" | "scene" | "lod" | "render";
export type Level = "debug" | "info" | "warn" | "error";

export interface TelemetryEvent {
  /** Timestamp (ms), from the bus's clock. */
  t: number;
  category: Category;
  level: Level;
  /** Short event name, e.g. "cut", "frame", "scan". */
  event: string;
  /** Arbitrary structured payload. */
  data?: Record<string, unknown>;
}

/** Fixed-capacity ring buffer of events (most recent N retained). */
export class TelemetryLog {
  private buf: (TelemetryEvent | undefined)[];
  private head = 0; // next write slot
  private full = false;

  constructor(readonly capacity = 5000) {
    this.buf = new Array(Math.max(1, capacity));
  }

  push(e: TelemetryEvent): void {
    this.buf[this.head] = e;
    this.head = (this.head + 1) % this.buf.length;
    if (this.head === 0) this.full = true;
  }

  /** Number of events currently retained. */
  get size(): number {
    return this.full ? this.buf.length : this.head;
  }

  /** Events in chronological (oldest-first) order. */
  snapshot(): TelemetryEvent[] {
    if (!this.full) return this.buf.slice(0, this.head) as TelemetryEvent[];
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)] as TelemetryEvent[];
  }

  /** Newline-delimited JSON of the snapshot (one event per line). */
  toNDJSON(): string {
    return this.snapshot()
      .map((e) => JSON.stringify(e))
      .join("\n");
  }

  clear(): void {
    this.buf = new Array(this.buf.length);
    this.head = 0;
    this.full = false;
  }
}
