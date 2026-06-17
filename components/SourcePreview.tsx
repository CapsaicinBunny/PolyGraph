"use client";

import { useEffect, useState } from "react";
import { Box, Spinner, Text } from "@chakra-ui/react";
import { isTauri } from "@/lib/client/env";
import { readSource } from "@/lib/client/native";

interface SourcePreviewProps {
  projectRoot: string;
  filePath: string;
  /** 1-based declaration line. */
  line: number;
}

/** Lines of context shown after the declaration line (one line is shown before it). */
const CONTEXT_AFTER = 6;

// Extension → Shiki language id (a small, common subset; unknown falls back to text).
const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  swift: "swift",
  scala: "scala",
  lua: "lua",
  dart: "dart",
  sh: "bash",
  bash: "bash",
  json: "json",
  jsonc: "jsonc",
  vue: "vue",
  svelte: "svelte",
  sql: "sql",
};

function langFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGS[ext] ?? "text";
}

/**
 * A syntax-highlighted snippet of a node's declaration. Desktop only — it reads
 * the file through Tauri; in the browser it shows a hint. Shiki is loaded lazily
 * so it never weighs down the initial bundle.
 */
export function SourcePreview({ projectRoot, filePath, line }: SourcePreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri() || !projectRoot || line <= 0) return;
    let cancelled = false;
    setHtml(null);
    setError(null);
    void (async () => {
      try {
        const start = Math.max(1, line - 1);
        const code = await readSource(projectRoot, filePath, start, line + CONTEXT_AFTER);
        const { codeToHtml } = await import("shiki");
        const rendered = await codeToHtml(code, { lang: langFor(filePath), theme: "github-dark" });
        if (!cancelled) setHtml(rendered);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, filePath, line]);

  if (!isTauri()) {
    return (
      <Text fontSize="xs" color="fg.subtle">
        Source preview is available in the desktop app.
      </Text>
    );
  }
  if (line <= 0) return null;
  if (error) {
    return (
      <Text fontSize="xs" color="red.fg">
        Preview unavailable: {error}
      </Text>
    );
  }
  if (!html) return <Spinner size="sm" />;

  return (
    <Box
      fontSize="xs"
      overflowX="auto"
      rounded="md"
      borderWidth="1px"
      borderColor="border"
      css={{ "& pre": { padding: "8px", margin: 0, overflowX: "auto" } }}
      // Shiki output is trusted markup over our own source text (escaped by Shiki).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
