// Resolves the analysis sidecar base URL. In the Tauri app the Rust core injects
// window.__POLYGRAPH_API__ once the sidecar reports its port; under `next dev`
// the client talks to the fixed dev-sidecar port instead.

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
  return DEV_BASE;
}
