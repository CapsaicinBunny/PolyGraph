// Resolves the analysis sidecar base URL. In the Tauri app the Rust core injects
// window.__POLYGRAPH_API__ once the sidecar reports its port; under `next dev`
// the client talks to the fixed dev-sidecar port instead.

import { isTauri } from "./env";

const DEV_BASE = "http://127.0.0.1:4319";

declare global {
  interface Window {
    __POLYGRAPH_API__?: string;
  }
}

export function apiBase(): string {
  if (typeof window !== "undefined" && window.__POLYGRAPH_API__) {
    return window.__POLYGRAPH_API__;
  }
  // In the desktop app the Rust core injects the real port; if it isn't set yet
  // the sidecar is still starting (or failed). Surface that instead of silently
  // hitting the dev port, which isn't listening in a packaged build.
  if (isTauri()) {
    throw new Error("The analysis engine is still starting — try again in a moment.");
  }
  return DEV_BASE;
}
