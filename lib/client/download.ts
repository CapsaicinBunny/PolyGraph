// Browser helpers for delivering an export to the user: trigger a file download,
// rasterize SVG → PNG, and copy text. Browser-only (DOM APIs); not unit-tested.

import { isTauri } from "./env";

/** A Save-dialog file filter derived from a filename's extension. */
function filtersFor(filename: string): { name: string; extensions: string[] }[] | undefined {
  const ext = filename.split(".").pop();
  return ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined;
}

/**
 * Save `text` as `filename`. On the desktop app this opens a native Save-As dialog
 * (the user picks where) and writes the chosen path; in the browser it falls back to
 * a download. Returns false if the user cancelled the dialog.
 */
export async function saveTextFile(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({ defaultPath: filename, filters: filtersFor(filename) });
    if (!path) return false;
    await invoke("write_file", { path, content: text });
    return true;
  }
  downloadText(filename, text, mime);
  return true;
}

/** Save a binary Blob as `filename` (native Save-As on desktop, download in browser). */
export async function saveBlobFile(filename: string, blob: Blob): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({ defaultPath: filename, filters: filtersFor(filename) });
    if (!path) return false;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    await invoke("write_file_base64", { path, base64: btoa(bin) });
    return true;
  }
  downloadBlob(filename, blob);
  return true;
}

/** Trigger a download of `text` as `filename` with the given MIME type. */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/** Trigger a download of a Blob as `filename`. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Rasterize an SVG string to a PNG Blob at `scale` device pixels per SVG unit.
 * Draws the SVG into an offscreen canvas via an Image. `width`/`height` are the
 * SVG's intrinsic pixel size.
 */
export function svgToPngBlob(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG encoding failed"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load SVG for rasterization"));
    };
    img.src = url;
  });
}

/** Copy text to the clipboard (async clipboard API, with a legacy fallback). */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}
