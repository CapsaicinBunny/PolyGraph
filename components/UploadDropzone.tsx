"use client";

import { useRef, useState } from "react";
import { Box, Button, Heading, HStack, Progress, Stack, Text } from "@chakra-ui/react";
import { readSourceFiles } from "@/lib/client/read-files";
import type { AnalyzeResult, SourceFileMap } from "@/lib/graph/types";

interface UploadDropzoneProps {
  onResult: (result: AnalyzeResult, stats: { fileCount: number; skipped: number }) => void;
}

type Phase = "idle" | "reading" | "analyzing";

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
  const label = reading
    ? `Reading files… ${progress.done}/${progress.total || "…"}`
    : `Analyzing ${fileCount} ${fileCount === 1 ? "file" : "files"}…`;

  return (
    <Progress.Root
      // Indeterminate (animated stripes) while the server analyzes; determinate while reading.
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
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [fileCount, setFileCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== "idle";

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
      // On success the parent swaps this view out; no need to reset state.
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
    <Box
      w="full"
      maxW="640px"
      mx="auto"
      mt="20"
      p="10"
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
        <Text fontSize="5xl">📂</Text>
        <Heading size="lg">Drop a project folder</Heading>
        <Text color="fg.muted" maxW="md">
          Drag a folder here, or pick one below. Files are read in your browser and sent for
          analysis —
          <Text as="span" color="fg.muted">
            {" "}
            node_modules and build output are skipped automatically.
          </Text>
        </Text>

        {busy ? (
          <ProgressBar phase={phase} progress={progress} fileCount={fileCount} />
        ) : (
          <Button colorPalette="blue" size="lg" onClick={() => inputRef.current?.click()}>
            Choose folder
          </Button>
        )}

        {error && (
          <Text color="red.400" fontSize="sm">
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
    </Box>
  );
}
