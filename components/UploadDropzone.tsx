"use client";

import { useRef, useState } from "react";
import { Box, Button, Heading, HStack, Input, Progress, Stack, Text } from "@chakra-ui/react";
import { readSourceFiles } from "@/lib/client/read-files";
import type { AnalyzeResult, SourceFileMap } from "@/lib/graph/types";

interface UploadDropzoneProps {
  onResult: (result: AnalyzeResult, stats: { fileCount: number; skipped: number }) => void;
}

type Phase = "idle" | "scanning" | "reading" | "analyzing";

function ProgressBar({
  phase,
  progress,
  fileCount,
}: {
  phase: Phase;
  progress: { done: number; total: number };
  fileCount: number;
}) {
  const reading = phase === "reading";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const label =
    phase === "scanning"
      ? "Scanning folder…"
      : reading
        ? `Reading files… ${progress.done}/${progress.total || "…"}`
        : `Analyzing ${fileCount} ${fileCount === 1 ? "file" : "files"}…`;

  return (
    <Progress.Root
      // Determinate while reading files in-browser; indeterminate stripes otherwise.
      value={reading ? pct : null}
      w="full"
      maxW="sm"
      size="sm"
      colorPalette="blue"
      striped={!reading}
      animated
    >
      <HStack justify="space-between" mb="1.5">
        <Progress.Label>{label}</Progress.Label>
        {reading && <Progress.ValueText />}
      </HStack>
      <Progress.Track>
        <Progress.Range />
      </Progress.Track>
    </Progress.Root>
  );
}

// Recursively collect File objects from a drag-drop of folders.
async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      Object.defineProperty(file, "webkitRelativePath", {
        value: `${prefix}${file.name}`,
        configurable: true,
      });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = () =>
        new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        batch = await readBatch();
      }
    }
  };

  await Promise.all(entries.map((e) => walk(e, "")));
  return out;
}

export function UploadDropzone({ onResult }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [fileCount, setFileCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== "idle";

  // Primary path: the server reads the folder directly from disk.
  async function scan(dirPath: string) {
    const trimmed = dirPath.trim();
    if (!trimmed) {
      setError("Enter a folder path to scan.");
      return;
    }
    setError(null);
    setPhase("scanning");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AnalyzeResult> & {
        error?: string;
        fileCount?: number;
        skipped?: number;
      };
      if (!res.ok || !data.graph) {
        throw new Error(data.error ?? `Scan failed (${res.status})`);
      }
      onResult(
        { graph: data.graph, errors: data.errors ?? [] },
        { fileCount: data.fileCount ?? data.graph.nodes.length, skipped: data.skipped ?? 0 },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setPhase("idle");
    }
  }

  // Fallback path: read files in the browser, then send their contents.
  async function analyze(files: SourceFileMap, skipped: number) {
    const count = Object.keys(files).length;
    setFileCount(count);
    setPhase("analyzing");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Analysis failed (${res.status})`);
      }
      const result = (await res.json()) as AnalyzeResult;
      onResult(result, { fileCount: count, skipped });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      setPhase("idle");
    }
  }

  async function handleFileList(list: FileList | File[]) {
    setError(null);
    setProgress({ done: 0, total: 0 });
    setPhase("reading");
    const { files, skipped } = await readSourceFiles(list, (done, total) =>
      setProgress({ done, total }),
    );
    if (Object.keys(files).length === 0) {
      setPhase("idle");
      setError("No .ts / .tsx / .js / .jsx files found in that folder.");
      return;
    }
    await analyze(files, skipped);
  }

  return (
    <Stack w="full" maxW="640px" mx="auto" mt="16" gap="6">
      {/* Primary: scan a path on this machine */}
      <Box p="6" borderWidth="1px" borderColor="border.emphasized" rounded="2xl" bg="bg.panel">
        <Stack gap="3">
          <Heading size="md">Scan a folder on this machine</Heading>
          <Text color="fg.muted" fontSize="sm">
            Enter an absolute folder path. It's read directly from disk by the local server —
            nothing is uploaded or copied. node_modules and build output are skipped.
          </Text>
          <HStack gap="2">
            <Input
              placeholder="C:\\path\\to\\your\\project"
              value={path}
              disabled={busy}
              fontFamily="mono"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void scan(path);
              }}
            />
            <Button colorPalette="blue" disabled={busy} onClick={() => void scan(path)}>
              Scan
            </Button>
          </HStack>
          {busy && phase === "scanning" && (
            <ProgressBar phase={phase} progress={progress} fileCount={fileCount} />
          )}
        </Stack>
      </Box>

      <HStack color="fg.subtle" fontSize="xs">
        <Box flex="1" h="1px" bg="border" />
        <Text>or use the in-browser picker</Text>
        <Box flex="1" h="1px" bg="border" />
      </HStack>

      {/* Fallback: pick/drop a folder; files are read in the browser */}
      <Box
        p="8"
        borderWidth="2px"
        borderStyle="dashed"
        borderColor={dragging ? "blue.400" : "border.emphasized"}
        rounded="2xl"
        bg={dragging ? "blue.subtle" : "bg.panel"}
        transition="all 0.15s"
        textAlign="center"
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          const files = await filesFromDataTransfer(e.dataTransfer);
          await handleFileList(files);
        }}
      >
        <Stack gap="4" align="center">
          <Text fontSize="4xl">📂</Text>
          <Heading size="sm">Drop a project folder</Heading>

          {busy && phase !== "scanning" ? (
            <ProgressBar phase={phase} progress={progress} fileCount={fileCount} />
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
              Choose folder
            </Button>
          )}
        </Stack>
      </Box>

      {error && (
        <Text color="red.400" fontSize="sm" textAlign="center">
          {error}
        </Text>
      )}

      <input
        ref={inputRef}
        type="file"
        // @ts-expect-error non-standard but widely supported directory picker attributes
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void handleFileList(e.target.files);
        }}
      />
    </Stack>
  );
}
