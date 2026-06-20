// Capture everything that can take the webview down into telemetry, so a crash
// leaves a trail in session.ndjson (persist.ts mirrors the buffer to disk every
// second + on pagehide). Without these, an uncaught error or rejected promise
// white-screens the app and the buffer dies with the page — invisible in the logs.
//
// Install once, as early as possible (ErrorBoundary.componentDidMount). SSR/Node-safe
// and idempotent. React *render* crashes are caught separately by ErrorBoundary; this
// covers async errors, event-handler throws, rejected promises, and failed resources.

import { flushSessionLog } from "./persist";
import { telemetry } from "./telemetry";

let installed = false;

/** Clip long stacks so one crash can't blow the ring-buffer/event budget. */
function clip(s: string | undefined, max = 2000): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // A breadcrumb at the top of every session: what build, browser, and viewport this
  // log was recorded on — so a downloaded log is self-describing.
  telemetry.event("app", "session-start", {
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    online: navigator.onLine,
    mode: process.env.NODE_ENV,
  });

  // Uncaught exceptions + failed resource loads (the latter fire on the element and only
  // reach window in the capture phase, hence `true`).
  window.addEventListener(
    "error",
    (e: ErrorEvent) => {
      // A failed resource (img/script/link/…) targets the element; a script error targets window.
      if (e.target instanceof Element) {
        const el = e.target;
        telemetry.event(
          "app",
          "resource-error",
          {
            tag: el.tagName.toLowerCase(),
            url: el.getAttribute("src") || el.getAttribute("href") || undefined,
          },
          "error",
        );
        return;
      }
      telemetry.event(
        "app",
        "uncaught-error",
        {
          message: e.message,
          source: e.filename || undefined,
          line: e.lineno || undefined,
          col: e.colno || undefined,
          stack: clip(e.error instanceof Error ? e.error.stack : undefined),
        },
        "error",
      );
      flushSessionLog(); // get the crash to disk now, before a hard failure can kill the page
    },
    true,
  );

  // Promises rejected with no .catch() — the most common silent failure mode.
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: unknown = e.reason;
    telemetry.event(
      "app",
      "unhandled-rejection",
      {
        message: r instanceof Error ? r.message : String(r),
        stack: clip(r instanceof Error ? r.stack : undefined),
      },
      "error",
    );
    flushSessionLog();
  });

  // Tab hidden/frozen right before a truncated log explains the gap.
  window.addEventListener("visibilitychange", () => {
    telemetry.event("app", "visibility", { state: document.visibilityState }, "debug");
  });
  window.addEventListener("online", () => telemetry.event("app", "online", {}, "debug"));
  window.addEventListener("offline", () => telemetry.event("app", "offline", {}, "warn"));
}
