"use client";

// Last line of defence for the whole UI tree. Two jobs:
//  1. Catch React *render/lifecycle* exceptions that would otherwise white-screen the
//     app — log them to telemetry (→ session.ndjson) and show a recovery card.
//  2. Install the global async/rejection/resource error handlers on mount (earliest
//     reliable client mount point), so non-render crashes are captured too.
// Styling is inline on purpose: the theme Provider may be the very thing that threw,
// so the fallback must not depend on it.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { isTauri } from "@/lib/client/env";
import { telemetry } from "@/lib/telemetry";
import { installGlobalErrorHandlers } from "@/lib/telemetry/global-errors";
import { flushSessionLog } from "@/lib/telemetry/persist";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidMount(): void {
    installGlobalErrorHandlers();
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    telemetry.event(
      "app",
      "react-error",
      {
        message: error.message,
        stack: error.stack?.slice(0, 2000),
        componentStack: info.componentStack?.slice(0, 2000),
      },
      "error",
    );
    flushSessionLog();
  }

  // Export the in-memory telemetry buffer directly. The boundary has replaced the whole tree, so
  // Settings (its usual "Download session log" button) is unmounted; this is the only way out, and
  // on web there's no logs/session.ndjson at all (the disk mirror is desktop-only).
  private downloadLog = (): void => {
    try {
      const blob = new Blob([telemetry.toNDJSON()], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "polygraph-crash-log.ndjson";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* best-effort — the buffer is also on disk on desktop */
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          height: "100vh",
          background: "#0b0e14",
          color: "#e6e6e6",
          fontFamily: "system-ui, sans-serif",
          padding: 24,
          textAlign: "center",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>PolyGraph hit an error.</h2>
        <p style={{ margin: 0, maxWidth: 560, opacity: 0.7, fontSize: 13, lineHeight: 1.5 }}>
          Reloading usually recovers. If it keeps happening, download the session log below and
          share it
          {isTauri() ? (
            <>
              {" "}
              (it's also at <code>logs/session.ndjson</code>)
            </>
          ) : null}
          .
        </p>
        <pre
          style={{
            maxWidth: 560,
            maxHeight: 160,
            overflow: "auto",
            background: "#11151f",
            border: "1px solid #232a38",
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            color: "#ff8f8f",
            whiteSpace: "pre-wrap",
            textAlign: "left",
          }}
        >
          {error.message}
        </pre>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={this.downloadLog}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid #2d6cdf",
              background: "transparent",
              color: "#cdd6f4",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Download log
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid #2d6cdf",
              background: "#1f4fb0",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
