// True when running inside the Tauri webview (v2 exposes __TAURI_INTERNALS__).
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
