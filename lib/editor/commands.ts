// Pure builders for the OS commands behind "Open in VS Code / JetBrains" and
// "Reveal in file manager". Kept free of any Tauri/DOM dependency so the exact
// program + argv is unit-testable; the desktop layer (lib/client/native.ts)
// just spawns what these return.

import type { GraphNode } from "../graph/types";

export type Platform = "win32" | "darwin" | "linux";
export type Editor = "vscode" | "jetbrains";

export interface Invocation {
  program: string;
  args: string[];
}

/** Join a project root and a relative path, normalized to the platform's separators. */
export function toAbsolute(projectRoot: string, relPath: string, platform: Platform): string {
  const root = projectRoot.replace(/[\\/]+$/, "");
  const joined = `${root}/${relPath}`;
  // Collapse any doubled separators, then pick the platform separator.
  const parts = joined.split(/[\\/]+/);
  return platform === "win32" ? parts.join("\\") : parts.join("/");
}

/** The CLI launcher name for an editor on a platform (best-effort defaults). */
function editorProgram(editor: Editor, platform: Platform): string {
  if (editor === "vscode") return platform === "win32" ? "code.cmd" : "code";
  return platform === "win32" ? "idea.bat" : "idea"; // JetBrains IDEA launcher
}

/**
 * Command to open `relPath` at `line` (1-based) in an editor.
 * VS Code uses `--goto file:line:col`; JetBrains uses `--line N file`.
 */
export function editorInvocation(
  editor: Editor,
  projectRoot: string,
  relPath: string,
  line: number,
  platform: Platform,
  column = 1,
): Invocation {
  const abs = toAbsolute(projectRoot, relPath, platform);
  const ln = Math.max(1, line);
  const col = Math.max(1, column);
  const program = editorProgram(editor, platform);
  if (editor === "vscode") {
    return { program, args: ["--goto", `${abs}:${ln}:${col}`] };
  }
  return { program, args: ["--line", String(ln), "--column", String(col), abs] };
}

/**
 * Command to open a file with the OS's default application for its type (file
 * association) — the OS picks the program, not us. No line number: the default
 * handler decides. Windows uses `start` (via cmd), which wraps ShellExecute.
 */
export function openInvocation(
  projectRoot: string,
  relPath: string,
  platform: Platform,
): Invocation {
  const abs = toAbsolute(projectRoot, relPath, platform);
  if (platform === "win32") return { program: "cmd", args: ["/c", "start", "", abs] };
  if (platform === "darwin") return { program: "open", args: [abs] };
  return { program: "xdg-open", args: [abs] };
}

/** Command to reveal a file in the OS file manager (selected where supported). */
export function revealInvocation(
  projectRoot: string,
  relPath: string,
  platform: Platform,
): Invocation {
  const abs = toAbsolute(projectRoot, relPath, platform);
  if (platform === "win32") return { program: "explorer", args: [`/select,${abs}`] };
  if (platform === "darwin") return { program: "open", args: ["-R", abs] };
  // Linux file managers can't reliably select a file — open its directory.
  const dir = abs.slice(0, Math.max(0, abs.lastIndexOf("/"))) || "/";
  return { program: "xdg-open", args: [dir] };
}

/** A copyable identifier for a node: `filePath#symbol` for symbols, else the path. */
export function symbolPath(node: Pick<GraphNode, "kind" | "filePath" | "label" | "line">): string {
  if (node.kind === "file") return node.filePath;
  return `${node.filePath}#${node.label}`;
}

/** A copyable `filePath:line` location for a node (line omitted when unknown). */
export function fileLocation(node: Pick<GraphNode, "filePath" | "line">): string {
  return node.line > 0 ? `${node.filePath}:${node.line}` : node.filePath;
}
