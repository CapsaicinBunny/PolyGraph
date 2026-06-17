"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  Image,
  Input,
  InputGroup,
  Progress,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { readSourceFiles } from "@/lib/client/read-files";
import { apiBase } from "@/lib/client/api";
import { isTauri } from "@/lib/client/env";
import type { AnalyzeResult, SourceFileMap } from "@/lib/graph/types";
import { ThemeToggle } from "./ThemeToggle";

interface UploadDropzoneProps {
  onResult: (result: AnalyzeResult, stats: { fileCount: number; skipped: number }) => void;
}

type Phase = "idle" | "scanning" | "reading" | "analyzing";

// What the scanner detects — shown as a teaser row under the hero.
const CAPABILITIES: { label: string; palette: string }[] = [
  { label: "Imports", palette: "gray" },
  { label: "Calls", palette: "blue" },
  { label: "Inheritance", palette: "purple" },
  { label: "Implements", palette: "cyan" },
  { label: "Composition", palette: "teal" },
  { label: "Instantiation", palette: "orange" },
];

// A representative slice of the ~25 supported languages, shown on the dropzone.
const SUPPORTED = ["TS", "JS", "Python", "Rust", "Go", "Java", "C++", "C#", "Swift", "Ruby", "SQL"];

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
  // Set when a scan is large enough to need confirmation before we analyze it.
  const [pendingConfirm, setPendingConfirm] = useState<{ path: string; fileCount: number } | null>(
    null,
  );

  const busy = phase !== "idle";

  // Only true inside the Tauri desktop app (gated on mount to avoid a hydration
  // mismatch against the statically-exported HTML).
  const [tauri, setTauri] = useState(false);
  useEffect(() => setTauri(isTauri()), []);

  // Native folder picker (desktop only): returns a real absolute path that is sent
  // to the sidecar's /scan endpoint, which reads the folder from disk.
  async function pickFolder() {
    let open: typeof import("@tauri-apps/plugin-dialog").open;
    try {
      ({ open } = await import("@tauri-apps/plugin-dialog"));
    } catch {
      setError("The folder picker is unavailable here — type the path above instead.");
      return;
    }
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: "Choose a project folder",
      });
      if (typeof dir === "string") {
        setPath(dir);
        void scan(dir);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the folder picker.");
    }
  }

  // Primary path: the server reads the folder directly from disk (no upload).
  // `force` skips the over-size confirmation gate.
  async function scan(dirPath: string, force = false) {
    const trimmed = dirPath.trim();
    if (!trimmed) {
      setError("Enter a folder path to scan.");
      return;
    }
    setError(null);
    setPendingConfirm(null);
    setPhase("scanning");
    const t0 = performance.now();
    try {
      const res = await fetch(`${apiBase()}/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: trimmed, force }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<AnalyzeResult> & {
        error?: string;
        fileCount?: number;
        skipped?: number;
        oversize?: boolean;
      };
      console.info(`[polygraph] /scan round-trip ${(performance.now() - t0).toFixed(0)}ms`);
      // Large scan — let the user confirm before we run the heavy analysis.
      if (res.ok && data.oversize) {
        setPhase("idle");
        setPendingConfirm({ path: trimmed, fileCount: data.fileCount ?? 0 });
        return;
      }
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

    // Serializing the whole file map can exceed V8's max string length
    // (~512 MB) on very large projects — there's no way around it in the
    // browser, so steer the user to the server path-scan (which sends only the
    // folder path and returns just the graph).
    let body: string;
    try {
      body = JSON.stringify({ files });
    } catch {
      setPhase("idle");
      setError(
        "This project is too large to read in the browser. Use the “Scan a folder” box above — the local server reads it directly from disk, with no size limit.",
      );
      return;
    }

    try {
      const res = await fetch(`${apiBase()}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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
    try {
      const { files, skipped } = await readSourceFiles(list, (done, total) =>
        setProgress({ done, total }),
      );
      if (Object.keys(files).length === 0) {
        setPhase("idle");
        setError("No source files found in that folder.");
        return;
      }
      await analyze(files, skipped);
    } catch (err) {
      setPhase("idle");
      setError(
        err instanceof Error
          ? `Couldn't read that folder: ${err.message}`
          : "Couldn't read that folder.",
      );
    }
  }

  return (
    <Container maxW="2xl" py={{ base: "10", md: "16" }}>
      <Stack gap="8">
        <Flex justify="flex-end" mb={{ base: "-4", md: "-8" }}>
          <ThemeToggle />
        </Flex>
        {/* Hero */}
        <Stack gap="4" align="center" textAlign="center">
          <Image
            src="/polygraph-icon.svg"
            alt="PolyGraph"
            boxSize={{ base: "76px", md: "92px" }}
            shadow="md"
            rounded="2xl"
          />
          <Stack gap="1.5" align="center">
            <Heading size={{ base: "xl", md: "2xl" }} letterSpacing="tight">
              PolyGraph
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
                  {tauri && (
                    <Button variant="outline" size="lg" onClick={() => void pickFolder()}>
                      Choose folder…
                    </Button>
                  )}
                  <Button colorPalette="blue" size="lg" px="8" onClick={() => void scan(path)}>
                    Scan
                  </Button>
                </Stack>
              </Stack>
            </Box>

            {!tauri && (
              <>
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
          </>
        )}

        {pendingConfirm && !busy && (
          <Box
            bg="bg.panel"
            borderWidth="1px"
            borderColor="border.emphasized"
            rounded="2xl"
            p={{ base: "5", md: "6" }}
            shadow="sm"
          >
            <Stack gap="3">
              <Heading size="sm">Large project — scan anyway?</Heading>
              <Text color="fg.muted" fontSize="sm">
                Found {pendingConfirm.fileCount.toLocaleString()} source files. A scan this big can
                take a while and may be heavy to render — scanning a subfolder is usually snappier.
              </Text>
              <HStack gap="2.5">
                <Button
                  colorPalette="blue"
                  onClick={() => {
                    const target = pendingConfirm.path;
                    setPendingConfirm(null);
                    void scan(target, true);
                  }}
                >
                  Scan anyway
                </Button>
                <Button variant="ghost" colorPalette="gray" onClick={() => setPendingConfirm(null)}>
                  Cancel
                </Button>
              </HStack>
            </Stack>
          </Box>
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
