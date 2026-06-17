// Desktop (Tauri) bridge for the editor-integration feature. Each function is a
// thin wrapper that builds an OS command with the pure helpers in
// lib/editor/commands.ts and runs it through a custom Rust command
// (spawn_detached / read_source_slice). Browser builds never call these — the UI
// gates them behind isTauri().

import {
  type Editor,
  editorInvocation,
  type Platform,
  revealInvocation,
  toAbsolute,
} from "../editor/commands";
import { isTauri } from "./env";

export { isTauri };

/** Best-effort OS family from the user-agent (the webview runs on the host OS). */
export function currentPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "win32";
  if (ua.includes("mac")) return "darwin";
  return "linux";
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function spawnDetached(program: string, args: string[]): Promise<void> {
  await invokeTauri("spawn_detached", { program, args });
}

/** Open `relPath` at `line` in the chosen editor (desktop only). */
export async function openInEditor(
  editor: Editor,
  projectRoot: string,
  relPath: string,
  line: number,
): Promise<void> {
  const { program, args } = editorInvocation(editor, projectRoot, relPath, line, currentPlatform());
  await spawnDetached(program, args);
}

/** Reveal `relPath` in the OS file manager (desktop only). */
export async function revealInFileManager(projectRoot: string, relPath: string): Promise<void> {
  const { program, args } = revealInvocation(projectRoot, relPath, currentPlatform());
  await spawnDetached(program, args);
}

/** Read lines [start, end] (1-based, inclusive) of a project file (desktop only). */
export async function readSource(
  projectRoot: string,
  relPath: string,
  start: number,
  end: number,
): Promise<string> {
  const path = toAbsolute(projectRoot, relPath, currentPlatform());
  return invokeTauri<string>("read_source_slice", { path, start, end });
}
