// Mirror the in-memory telemetry buffer to logs/session.ndjson (next to the Rust
// app log) so the rich LOD/render trace survives a crash — the webview's buffer is
// otherwise lost when the page dies (e.g. an out-of-memory white-screen). Desktop
// only: it calls the Tauri `append_session_log` command. In the browser this is a
// no-op; use the Settings "Download session log" button there.

import { isTauri } from "@/lib/client/env";
import { telemetry } from "@/lib/telemetry";
import type { TelemetryEvent } from "./events";

/** Events newer than the last flushed timestamp (snapshot is oldest-first). */
export function eventsSince(events: readonly TelemetryEvent[], lastT: number): TelemetryEvent[] {
  return events.filter((e) => e.t > lastT);
}

let started = false;

/**
 * Start periodically flushing new telemetry events to logs/session.ndjson. Safe to
 * call more than once (only the first call starts the loop). No-op outside Tauri.
 */
export function startSessionLogPersist(intervalMs = 1000): void {
  if (started || !isTauri()) return;
  started = true;

  let lastT = Number.NEGATIVE_INFINITY;
  let firstWrite = true;
  let flushing = false;

  const flush = async (): Promise<void> => {
    if (flushing) return;
    const fresh = eventsSince(telemetry.log.snapshot(), lastT);
    if (fresh.length === 0) return;
    flushing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const content = `${fresh.map((e) => JSON.stringify(e)).join("\n")}\n`;
      // Truncate on the first write so each app run starts a fresh session file.
      await invoke("append_session_log", { content, reset: firstWrite });
      firstWrite = false;
      lastT = fresh[fresh.length - 1]!.t;
    } catch {
      // Keep lastT/firstWrite so the same events retry on the next tick.
    } finally {
      flushing = false;
    }
  };

  setInterval(() => void flush(), intervalMs);
  // Best-effort final flush when the window is going away.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => void flush());
  }
}
