"use client";

import { useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Input,
  InputGroup,
  Progress,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { readSourceFiles } from "@/lib/client/read-files";
import type { AnalyzeResult, SourceFileMap } from "@/lib/graph/types";

interface UploadDropzoneProps {
  onResult: (result: AnalyzeResult, stats: { fileCount: number; skipped: number }) => void;
}

type Phase = "idle" | "scanning" | "reading" | "analyzing";

// What the scanner detects — shown as a teaser row under the hero.
const CAPABILITIES: { label: string; palette: string }[] = [
  { label: "Imports", palette: "gray" },
  { label: "Calls", palette: "blue" },
  { label: "Inheritance", palette: "purple" },
  { label: "Composition", palette: "teal" },
  { label: "React / Vue / Svelte / Angular", palette: "green" },
  { label: "ECS", palette: "orange" },
];

// A representative slice of the ~25 supported languages, shown on the dropzone.
const SUPPORTED = ["TS", "JS", "Python", "Rust", "Go", "Java", "C++", "C#", "Swift", "Ruby", "SQL"];

function GraphMark() {
  return (
    <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
      <g strokeWidth="2.5" strokeLinecap="round">
        <line x1="15" y1="16" x2="31" y2="13" stroke="#64748b" />
        <line x1="16" y1="18" x2="22" y2="33" stroke="#3b82f6" />
        <line x1="33" y1="15" x2="34" y2="31" stroke="#a855f7" />
        <line x1="24" y1="35" x2="33" y2="33" stroke="#22c55e" />
      </g>
      <circle cx="14" cy="16" r="5" fill="#94a3b8" />
      <circle cx="33" cy="13" r="5" fill="#a855f7" />
      <circle cx="23" cy="34" r="5" fill="#3b82f6" />
      <circle cx="35" cy="32" r="5" fill="#22c55e" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style={{ opacity: 0.7 }}>
      <path
        fill="currentColor"
        d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
      />
    </svg>
  );
}

// The busy state — shown immediately on scan/read so a long server walk never
// looks dead. Scanning + analyzing are indeterminate (the server has no granular
// progress); the in-browser read reports done/total.
function StatusPanel({
  phase,
  progress,
  fileCount,
}: {
  phase: Exclude<Phase, "idle">;
  progress: { done: number; total: number };
  fileCount: number;
}) {
  const reading = phase === "reading";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const title =
    phase === "scanning"
      ? "Scanning folder on disk…"
      : reading
        ? "Reading files in your browser…"
        : `Analyzing ${fileCount} ${fileCount === 1 ? "file" : "files"}…`;
  const note =
    phase === "scanning"
      ? "Reading and parsing every file — large projects can take 10–20 seconds."
      : reading
        ? `${progress.done}/${progress.total || "…"} files`
        : "Resolving imports, calls, and inheritance across the codebase.";

  return (
    <Box
      p={{ base: "6", md: "8" }}
      borderWidth="1px"
      borderColor="border.emphasized"
      rounded="2xl"
      bg="bg.panel"
      shadow="sm"
    >
      <Stack gap="4">
        <HStack gap="3">
          <Spinner size="sm" color="blue.solid" borderWidth="2px" />
          <Text fontWeight="semibold">{title}</Text>
        </HStack>
        <Progress.Root value={reading ? pct : null} size="sm" colorPalette="blue" striped animated>
          <Progress.Track>
            <Progress.Range />
          </Progress.Track>
        </Progress.Root>
        <Text fontSize="sm" color="fg.muted">
          {note}
        </Text>
      </Stack>
    </Box>
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

  // Primary path: the server reads the folder directly from disk (no upload).
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
      setError("No source files found in that folder.");
      return;
    }
    await analyze(files, skipped);
  }

  return (
    <Container maxW="2xl" py={{ base: "10", md: "16" }}>
      <Stack gap="8">
        {/* Hero */}
        <Stack gap="4" align="center" textAlign="center">
          <Box
            color="fg"
            p="3"
            rounded="2xl"
            bg="bg.subtle"
            borderWidth="1px"
            borderColor="border.emphasized"
            shadow="sm"
          >
            <GraphMark />
          </Box>
          <Stack gap="1.5" align="center">
            <Heading size={{ base: "xl", md: "2xl" }} letterSpacing="tight">
              Code Atlas
            </Heading>
            <Text color="fg.muted" maxW="lg">
              Map a codebase into an interactive graph — modules, types, functions, and what calls
              what. ~25 languages, framework- and paradigm-agnostic.
            </Text>
          </Stack>
          <Flex wrap="wrap" justify="center" gap="2" pt="1">
            {CAPABILITIES.map((c) => (
              <Badge
                key={c.label}
                variant="subtle"
                colorPalette={c.palette}
                rounded="full"
                px="2.5"
              >
                {c.label}
              </Badge>
            ))}
          </Flex>
        </Stack>

        {busy ? (
          <StatusPanel phase={phase} progress={progress} fileCount={fileCount} />
        ) : (
          <>
            {/* Primary: scan a path on this machine */}
            <Box
              p={{ base: "5", md: "6" }}
              borderWidth="1px"
              borderColor="border.emphasized"
              rounded="2xl"
              bg="bg.panel"
              shadow="sm"
            >
              <Stack gap="4">
                <Stack gap="1">
                  <Heading size="md">Scan a folder</Heading>
                  <Text color="fg.muted" fontSize="sm">
                    Enter an absolute path. The local server reads it directly from disk — nothing
                    is uploaded or copied;{" "}
                    <Text as="span" color="fg.subtle">
                      node_modules
                    </Text>{" "}
                    and build output are skipped.
                  </Text>
                </Stack>

                <Stack direction={{ base: "column", sm: "row" }} gap="2.5">
                  <InputGroup flex="1" startElement={<FolderIcon />}>
                    <Input
                      placeholder="C:\\path\\to\\your\\project"
                      value={path}
                      fontFamily="mono"
                      size="lg"
                      aria-label="Folder path to scan"
                      onChange={(e) => setPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void scan(path);
                      }}
                    />
                  </InputGroup>
                  <Button colorPalette="blue" size="lg" px="8" onClick={() => void scan(path)}>
                    Scan
                  </Button>
                </Stack>
              </Stack>
            </Box>

            <HStack color="fg.subtle" fontSize="xs" gap="3">
              <Box flex="1" h="1px" bg="border" />
              <Text>or read a folder in your browser</Text>
              <Box flex="1" h="1px" bg="border" />
            </HStack>

            {/* Fallback: pick/drop a folder; files are read locally in the page. */}
            <Box
              role="button"
              tabIndex={0}
              w="full"
              textAlign="center"
              p={{ base: "8", md: "10" }}
              borderWidth="2px"
              borderStyle="dashed"
              borderColor={dragging ? "blue.400" : "border.emphasized"}
              rounded="2xl"
              bg={dragging ? "blue.subtle" : "transparent"}
              transition="all 0.15s"
              cursor="pointer"
              _hover={{ borderColor: "blue.400", bg: "bg.subtle" }}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setDragging(false);
                const files = await filesFromDataTransfer(e.dataTransfer);
                await handleFileList(files);
              }}
            >
              <Stack gap="2" align="center">
                <Text fontSize="3xl">📂</Text>
                <Text fontWeight="semibold" fontSize="md">
                  Drop a project folder
                </Text>
                <Text fontSize="xs" color="fg.subtle" maxW="sm">
                  Files are read here in the page and processed locally. Browsers can't reveal a
                  folder's path, so this can't fill the box above — and your browser will ask to
                  confirm reading the folder.
                </Text>
                <Flex wrap="wrap" justify="center" gap="1" pt="2" maxW="md">
                  {SUPPORTED.map((ext) => (
                    <Badge key={ext} size="sm" variant="outline" colorPalette="gray">
                      {ext}
                    </Badge>
                  ))}
                  <Badge size="sm" variant="outline" colorPalette="gray">
                    +14 more
                  </Badge>
                </Flex>
              </Stack>
            </Box>
          </>
        )}

        {error && (
          <Box
            role="alert"
            bg="red.subtle"
            color="red.fg"
            borderWidth="1px"
            borderColor="red.emphasized"
            rounded="lg"
            px="4"
            py="2.5"
            fontSize="sm"
            textAlign="center"
          >
            {error}
          </Box>
        )}

        <Text fontSize="xs" color="fg.subtle" textAlign="center">
          Runs entirely on your machine. Nothing leaves your computer.
        </Text>

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
    </Container>
  );
}
