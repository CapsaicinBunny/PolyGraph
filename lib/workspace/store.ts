// Named workspaces persisted in localStorage. Browser-only; every function is a
// no-op / empty when storage is unavailable (SSR, private mode), so callers
// don't need to guard. Pure transforms live in serialize.ts.

import type { Workspace } from "./schema";

const KEY = "polygraph.workspaces.v1";

export interface NamedWorkspace {
  name: string;
  savedAt: number;
  workspace: Workspace;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readAll(): NamedWorkspace[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as NamedWorkspace[]) : [];
  } catch {
    return [];
  }
}

function writeAll(items: NamedWorkspace[]): void {
  storage()?.setItem(KEY, JSON.stringify(items));
}

/** All saved workspaces, most-recent first. */
export function listWorkspaces(): NamedWorkspace[] {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
}

/** Save (or overwrite) a workspace under `name`. */
export function saveWorkspace(name: string, workspace: Workspace, now: number): void {
  const items = readAll().filter((w) => w.name !== name);
  items.push({ name, savedAt: now, workspace });
  writeAll(items);
}

export function loadWorkspace(name: string): Workspace | null {
  return readAll().find((w) => w.name === name)?.workspace ?? null;
}

export function deleteWorkspace(name: string): void {
  writeAll(readAll().filter((w) => w.name !== name));
}
