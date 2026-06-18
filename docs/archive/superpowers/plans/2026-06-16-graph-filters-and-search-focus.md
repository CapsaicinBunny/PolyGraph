# Graph filters panel + search-to-focus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add file-level filtering (a right-side panel that toggles file visibility by top-level folder and by language, JSON hidden by default), exclude build/dependency dirs from scans, and make search pan/zoom to frame the match.

**Architecture:** Pure helpers derive folders/languages from the loaded graph and frame a set of nodes; `scene.ts`'s `visible()` gains a folder+language gate (applied to files and their symbols); a new `FiltersPanel` and `Explorer` state drive it; `VelloGraphCanvas` carries the two new filter sets and frames search matches via a pure camera helper. All client-side — no re-scan, no renderer/WASM change.

**Tech Stack:** Next.js 15 + Chakra UI v3, TypeScript (tsgo), `bun test`, the existing Vello canvas.

---

## File structure

- **Modify** `lib/file-filters.ts` — extend `IGNORE_DIR` with build/dep dirs.
- **Create** `lib/graph/filters.ts` — `topFolderOf`, `fileLanguage`, `availableFolders`, `availableLanguages`, `DEFAULT_HIDDEN_LANGUAGES`.
- **Create** `lib/graph/frame.ts` — `frameBoxes` (pure bbox→camera).
- **Modify** `lib/graph/scene.ts` — `SceneFilters` gains `enabledFolders`/`enabledLanguages`; `visible()` gate; signature.
- **Create** `components/FiltersPanel.tsx` — the right-side panel.
- **Modify** `components/VelloGraphCanvas.tsx` — new props + filters memo + search-focus effect.
- **Modify** `components/Explorer.tsx` — derive lists, hold state, funnel toggle, render panel, pass props, reset.
- **Modify** `components/Sidebar.tsx` — caption under "Node types".
- **Tests:** `lib/file-filters.test.ts`, `lib/graph/filters.test.ts`, `lib/graph/frame.test.ts`, `lib/graph/scene.test.ts`.

All commands run from `/c/Git/TSModuleScanner` (prefix bash with `cd /c/Git/TSModuleScanner && …`).

---

## Task 1: Exclude build/dependency dirs from scans

**Files:**
- Modify: `lib/file-filters.ts`
- Test: `lib/file-filters.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/file-filters.test.ts`:

```ts
import { expect, test } from "bun:test";
import { isSourcePath } from "./file-filters";

test("ordinary source files are included", () => {
  expect(isSourcePath("src/foo.ts")).toBe(true);
  expect(isSourcePath("lib/bar/baz.rs")).toBe(true);
});

test("Cargo target and other build/dep dirs are excluded", () => {
  expect(isSourcePath("target/debug/.fingerprint/lib-x/lib-toml.json")).toBe(false);
  expect(isSourcePath("crate/target/release/build-script-build.json")).toBe(false);
  expect(isSourcePath(".venv/lib/site.py")).toBe(false);
  expect(isSourcePath("app/__pycache__/x.py")).toBe(false);
  expect(isSourcePath("server/bin/Debug/x.cs")).toBe(false);
  expect(isSourcePath("server/obj/x.cs")).toBe(false);
  expect(isSourcePath("vendor/foo/bar.go")).toBe(false);
});

test("non-source extensions are excluded", () => {
  expect(isSourcePath("README.md")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/file-filters.test.ts`
Expected: FAIL — `target/…` etc. currently return `true`.

- [ ] **Step 3: Implement**

In `lib/file-filters.ts`, replace the `IGNORE_DIR` regex with:

```ts
// Matches an ignored directory segment anywhere in a path (either separator).
export const IGNORE_DIR =
  /(^|[\\/])(node_modules|\.git|\.next|dist|build|out|coverage|\.turbo|\.cache|target|\.venv|venv|__pycache__|vendor|bin|obj|\.gradle|Pods|\.dart_tool|\.svelte-kit|\.nuxt|\.idea|\.vscode)([\\/]|$)/;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/file-filters.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/file-filters.ts lib/file-filters.test.ts
git commit -m "Exclude build/dependency dirs (target, .venv, bin/obj, …) from scans"
```

---

## Task 2: Folder + language derivation helpers

**Files:**
- Create: `lib/graph/filters.ts`
- Test: `lib/graph/filters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/graph/filters.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { GraphModel, GraphNode } from "./types";
import {
  availableFolders,
  availableLanguages,
  DEFAULT_HIDDEN_LANGUAGES,
  fileLanguage,
  topFolderOf,
} from "./filters";

test("topFolderOf returns the first segment, or / for root files", () => {
  expect(topFolderOf("src/foo/bar.ts")).toBe("src");
  expect(topFolderOf("lib\\baz.rs")).toBe("lib");
  expect(topFolderOf("index.ts")).toBe("/");
});

test("fileLanguage maps extension to a key/label/color; JSON and unknown handled", () => {
  expect(fileLanguage("a.ts").key).toBe("TS");
  expect(fileLanguage("a.json").key).toBe("{}");
  expect(fileLanguage("a.json").label).toBe("JSON");
  expect(fileLanguage("a.unknownext").key).toBe("other");
});

test("JSON is hidden by default", () => {
  expect(DEFAULT_HIDDEN_LANGUAGES.has("{}")).toBe(true);
  expect(DEFAULT_HIDDEN_LANGUAGES.has("TS")).toBe(false);
});

function fileNode(filePath: string): GraphNode {
  return { id: filePath, kind: "file", label: filePath, filePath, line: 0, parentFile: filePath };
}

test("availableFolders + availableLanguages count file nodes", () => {
  const graph: GraphModel = {
    nodes: [
      fileNode("src/a.ts"),
      fileNode("src/b.ts"),
      fileNode("lib/c.rs"),
      fileNode("pkg.json"),
    ],
    edges: [],
  };
  expect(availableFolders(graph)).toEqual([
    { name: "src", count: 2 },
    { name: "/", count: 1 },
    { name: "lib", count: 1 },
  ]);
  const langs = availableLanguages(graph);
  expect(langs.find((l) => l.key === "TS")?.count).toBe(2);
  expect(langs.find((l) => l.key === "RS")?.count).toBe(1);
  expect(langs.find((l) => l.key === "{}")?.count).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/filters.test.ts`
Expected: FAIL — `./filters` not found.

- [ ] **Step 3: Implement**

Create `lib/graph/filters.ts`:

```ts
// File-level filtering helpers: derive the top-level folders and languages present
// in a graph (for the Filters panel) and classify a file's folder/language.
import type { GraphModel } from "./types";
import { languageBadge } from "./visual";

/** Top-level directory of a relative path, or "/" for repo-root files. */
export function topFolderOf(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  const slash = norm.indexOf("/");
  return slash === -1 ? "/" : norm.slice(0, slash);
}

export interface FileLanguage {
  /** Stable key (the language-badge code), e.g. "TS", "{}", or "other". */
  key: string;
  /** Human label, e.g. "TS", "JSON". */
  label: string;
  color: string;
}

// Friendlier labels for the cryptic badge codes; others display the code as-is.
const LANG_LABELS: Record<string, string> = {
  TX: "TSX",
  "C+": "C++",
  OC: "Obj-C",
  "{}": "JSON",
};

/** Language of a file from its extension badge; "other" if the extension is unknown. */
export function fileLanguage(filePath: string): FileLanguage {
  const badge = languageBadge(filePath);
  if (!badge) return { key: "other", label: "Other", color: "#6b7280" };
  return { key: badge.code, label: LANG_LABELS[badge.code] ?? badge.code, color: badge.color };
}

/** Languages that start hidden in the panel (re-enableable). JSON/JSONC. */
export const DEFAULT_HIDDEN_LANGUAGES: ReadonlySet<string> = new Set(["{}"]);

export interface FolderInfo {
  name: string;
  count: number;
}
export interface LanguageInfo extends FileLanguage {
  count: number;
}

/** Distinct top-level folders across file nodes, with counts, busiest first. */
export function availableFolders(graph: GraphModel): FolderInfo[] {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const f = topFolderOf(n.filePath);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Distinct languages across file nodes, with counts, busiest first. */
export function availableLanguages(graph: GraphModel): LanguageInfo[] {
  const byKey = new Map<string, LanguageInfo>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const lang = fileLanguage(n.filePath);
    const existing = byKey.get(lang.key);
    if (existing) existing.count += 1;
    else byKey.set(lang.key, { ...lang, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/filters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/graph/filters.ts lib/graph/filters.test.ts
git commit -m "Add folder/language derivation helpers for the filters panel"
```

---

## Task 3: Camera-framing helper (search-to-focus math)

**Files:**
- Create: `lib/graph/frame.ts`
- Test: `lib/graph/frame.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/graph/frame.test.ts`:

```ts
import { expect, test } from "bun:test";
import { frameBoxes } from "./frame";

test("returns null for no boxes or empty viewport", () => {
  expect(frameBoxes([], 800, 600)).toBeNull();
  expect(frameBoxes([{ x: 0, y: 0, width: 10, height: 10 }], 0, 600)).toBeNull();
});

test("centers a single small box and clamps to maxScale", () => {
  const cam = frameBoxes([{ x: 100, y: 100, width: 170, height: 44 }], 800, 600)!;
  expect(cam.scale).toBeCloseTo(1.2, 5); // clamped, not zoomed to fit
  // box center (185,122) maps to viewport center (400,300): cx = 400 - 185*scale
  expect(cam.x).toBeCloseTo(400 - 185 * 1.2, 3);
  expect(cam.y).toBeCloseTo(300 - 122 * 1.2, 3);
});

test("scales down to fit a large bounding box within padding", () => {
  const cam = frameBoxes([{ x: 0, y: 0, width: 4000, height: 200 }], 800, 600)!;
  // width-limited: (800 - 160) / 4000 = 0.16
  expect(cam.scale).toBeCloseTo(0.16, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/frame.test.ts`
Expected: FAIL — `./frame` not found.

- [ ] **Step 3: Implement**

Create `lib/graph/frame.ts`:

```ts
// Pure camera math for framing a set of world-space rects in the viewport. Mirrors
// the Vello renderer's camera convention: screen = world * scale + (x, y).
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * Camera that frames `boxes` centered in a `vw`×`vh` viewport with `padding`, scaled
 * to fit but clamped to `[0.02, maxScale]` so a single small box doesn't zoom to max.
 * Returns null if there's nothing to frame or the viewport is empty.
 */
export function frameBoxes(
  boxes: FrameBox[],
  vw: number,
  vh: number,
  maxScale = 1.2,
  padding = 80,
): Camera | null {
  if (boxes.length === 0 || vw <= 0 || vh <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const fit = Math.min((vw - padding * 2) / w, (vh - padding * 2) / h, maxScale);
  const scale = Math.max(0.02, fit);
  return {
    x: vw / 2 - ((minX + maxX) / 2) * scale,
    y: vh / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/frame.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/graph/frame.ts lib/graph/frame.test.ts
git commit -m "Add frameBoxes camera helper for search-to-focus"
```

---

## Task 4: Folder/language gate in the scene

**Files:**
- Modify: `lib/graph/scene.ts`
- Test: `lib/graph/scene.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/graph/scene.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { Environment, GraphModel, NodeCategory, Runtime } from "./types";
import { FILTERABLE_EDGE_KINDS, FILTERABLE_NODE_KINDS } from "./visual";
import { buildSceneStructure, type SceneFilters } from "./scene";

function fileNode(filePath: string) {
  return { id: filePath, kind: "file" as const, label: filePath, filePath, line: 0, parentFile: filePath };
}

const graph: GraphModel = {
  nodes: [fileNode("src/a.ts"), fileNode("lib/b.rs"), fileNode("pkg.json")],
  edges: [],
};

function filters(overrides: Partial<SceneFilters> = {}): SceneFilters {
  return {
    showExternal: false,
    enabledNodeKinds: new Set(FILTERABLE_NODE_KINDS),
    enabledCategories: new Set<NodeCategory>(["ui", "feature"]),
    enabledEnvironments: new Set<Environment>(["client", "server"]),
    enabledRuntimes: new Set<Runtime>(["node", "deno", "bun"]),
    enabledEdgeKinds: new Set(FILTERABLE_EDGE_KINDS),
    enabledFolders: new Set(["src", "lib", "/"]),
    enabledLanguages: new Set(["TS", "RS", "{}"]),
    ...overrides,
  };
}

test("all files visible when every folder + language is enabled", () => {
  const s = buildSceneStructure(graph, new Set(), filters(), "force", "LR");
  expect(s.nodes.map((n) => n.id).sort()).toEqual(["lib/b.rs", "pkg.json", "src/a.ts"]);
});

test("disabling a folder hides its files", () => {
  const s = buildSceneStructure(graph, new Set(), filters({ enabledFolders: new Set(["src", "/"]) }), "force", "LR");
  expect(s.nodes.map((n) => n.id)).not.toContain("lib/b.rs");
  expect(s.nodes.map((n) => n.id)).toContain("src/a.ts");
});

test("disabling a language hides its files (JSON off)", () => {
  const s = buildSceneStructure(graph, new Set(), filters({ enabledLanguages: new Set(["TS", "RS"]) }), "force", "LR");
  expect(s.nodes.map((n) => n.id)).not.toContain("pkg.json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/scene.test.ts`
Expected: FAIL — `SceneFilters` has no `enabledFolders`/`enabledLanguages`.

- [ ] **Step 3: Implement**

In `lib/graph/scene.ts`:

(a) add the import near the top (after the existing imports from `../aggregate`/`../layout`):

```ts
import { fileLanguage, topFolderOf } from "./filters";
```

(b) extend `SceneFilters`:

```ts
export interface SceneFilters {
  showExternal: boolean;
  enabledNodeKinds: Set<NodeKind>;
  enabledCategories: Set<NodeCategory>;
  enabledEnvironments: Set<Environment>;
  enabledRuntimes: Set<Runtime>;
  enabledEdgeKinds: Set<ViewEdgeKind>;
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
}
```

(c) in `buildSceneStructure`, destructure the two new sets and add the gate to `visible`:

Replace the filters destructure block with:

```ts
  const {
    showExternal,
    enabledNodeKinds,
    enabledCategories,
    enabledEnvironments,
    enabledRuntimes,
    enabledEdgeKinds,
    enabledFolders,
    enabledLanguages,
  } = filters;
```

Replace the `visible` function with:

```ts
  const visible = (n: GraphModel["nodes"][number]) => {
    if (n.kind === "external") return showExternal;
    // Folder + language gate — applies to files and the symbols inside them.
    if (!enabledFolders.has(topFolderOf(n.filePath))) return false;
    if (!enabledLanguages.has(fileLanguage(n.filePath).key)) return false;
    if (n.environment && !enabledEnvironments.has(n.environment)) return false;
    if (n.runtimes?.length && !n.runtimes.some((r) => enabledRuntimes.has(r))) return false;
    if (n.kind === "file") return true;
    return enabledNodeKinds.has(n.kind) && (!n.category || enabledCategories.has(n.category));
  };
```

(d) add the two sets to the `signature` array (so layout re-caches when they change). After the `ser(enabledEdgeKinds)` line, add:

```ts
    ser(enabledFolders),
    ser(enabledLanguages),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/graph/scene.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/graph/scene.ts lib/graph/scene.test.ts
git commit -m "Gate file/symbol visibility by folder + language in the scene"
```

---

## Task 5: VelloGraphCanvas — carry the new filters + frame search matches

**Files:**
- Modify: `components/VelloGraphCanvas.tsx`

- [ ] **Step 1: Add imports**

Add to the imports:

```ts
import { frameBoxes } from "@/lib/graph/frame";
```

- [ ] **Step 2: Add props**

In `GraphViewProps`, after `enabledRuntimes: Set<Runtime>;` add:

```ts
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
```

Destructure them in the component body alongside the other props (add `enabledFolders,` and `enabledLanguages,` to the destructure list).

- [ ] **Step 3: Include them in the filters memo**

Replace the `filters` `useMemo` so both the object and the dependency array include the two sets:

```ts
  const filters: SceneFilters = useMemo(
    () => ({
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
      enabledFolders,
      enabledLanguages,
    }),
    [
      showExternal,
      enabledNodeKinds,
      enabledCategories,
      enabledEnvironments,
      enabledRuntimes,
      enabledEdgeKinds,
      enabledFolders,
      enabledLanguages,
    ],
  );
```

- [ ] **Step 4: Add the search-focus effect**

Immediately after the existing selection/search effect (the one ending `}, [ready, selectedId, search]);`), add:

```ts
  // On search, frame the matching nodes so a match is visible even when zoomed out
  // (keeps the renderer's yellow match outline). No match → leave the camera put.
  useEffect(() => {
    const vc = vcRef.current;
    const canvas = canvasRef.current;
    if (!ready || !vc || !canvas) return;
    const q = search.trim().toLowerCase();
    if (!q) return;
    const boxes = scene.nodes
      .filter((n) => n.label.toLowerCase().includes(q))
      .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }));
    const target = frameBoxes(boxes, canvas.width, canvas.height);
    if (!target) return;
    cam.current = target;
    vc.set_camera(target.x, target.y, target.scale);
    vc.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, search]);
```

- [ ] **Step 5: Verify typecheck (component test runs after Explorer is wired)**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck`
Expected: errors ONLY in `Explorer.tsx` (it doesn't yet pass the new props) — `VelloGraphCanvas.tsx` itself must be clean. (Explorer is fixed in Task 7.)

- [ ] **Step 6: Commit**

```bash
cd /c/Git/TSModuleScanner
git add components/VelloGraphCanvas.tsx
git commit -m "VelloGraphCanvas: folder/language filters + frame search matches"
```

---

## Task 6: FiltersPanel component

**Files:**
- Create: `components/FiltersPanel.tsx`

- [ ] **Step 1: Create the component**

Create `components/FiltersPanel.tsx`:

```tsx
"use client";

import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import type { FolderInfo, LanguageInfo } from "@/lib/graph/filters";

interface FiltersPanelProps {
  folders: FolderInfo[];
  languages: LanguageInfo[];
  enabledFolders: Set<string>;
  enabledLanguages: Set<string>;
  onToggleFolder: (name: string) => void;
  onToggleLanguage: (key: string) => void;
  onSetFolders: (on: boolean) => void;
  onSetLanguages: (on: boolean) => void;
  onClose: () => void;
}

const BORDER_VAR = "var(--chakra-colors-border)";
const ACCENT = "#3b82f6";

function Row({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = color ?? ACCENT;
  return (
    <Flex
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      align="center"
      gap="2"
      px="2.5"
      py="1.5"
      rounded="md"
      borderWidth="1px"
      cursor="pointer"
      userSelect="none"
      fontSize="sm"
      color={active ? "fg" : "fg.muted"}
      opacity={active ? 1 : 0.55}
      _hover={{ opacity: 1 }}
      transition="opacity 0.12s"
      style={{
        backgroundColor: active ? `${accent}1f` : "transparent",
        borderColor: active ? accent : BORDER_VAR,
      }}
    >
      <Box w="8px" h="8px" rounded="full" flexShrink={0} style={{ backgroundColor: accent }} />
      <Text flex="1" lineClamp={1}>
        {label}
      </Text>
      <Text fontSize="xs" color="fg.subtle">
        {count}
      </Text>
    </Flex>
  );
}

function GroupHeader({ title, onAll, onNone }: { title: string; onAll: () => void; onNone: () => void }) {
  return (
    <Flex align="center" justify="space-between" mb="2">
      <Text fontSize="11px" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" color="fg.muted">
        {title}
      </Text>
      <HStack gap="2" fontSize="10px" color="fg.subtle">
        <Box as="button" cursor="pointer" _hover={{ color: "fg" }} onClick={onAll}>
          all
        </Box>
        <Box as="button" cursor="pointer" _hover={{ color: "fg" }} onClick={onNone}>
          none
        </Box>
      </HStack>
    </Flex>
  );
}

export function FiltersPanel({
  folders,
  languages,
  enabledFolders,
  enabledLanguages,
  onToggleFolder,
  onToggleLanguage,
  onSetFolders,
  onSetLanguages,
  onClose,
}: FiltersPanelProps) {
  return (
    <Stack
      w="260px"
      h="full"
      p="4"
      gap="5"
      bg="bg.panel"
      borderLeftWidth="1px"
      borderColor="border"
      overflowY="auto"
    >
      <Flex align="center" justify="space-between">
        <Text fontSize="sm" fontWeight="semibold">
          Filters
        </Text>
        <Box
          as="button"
          aria-label="Close filters"
          onClick={onClose}
          color="fg.muted"
          _hover={{ color: "fg" }}
          fontSize="lg"
          lineHeight="1"
        >
          ✕
        </Box>
      </Flex>

      <Box>
        <GroupHeader title="Folders" onAll={() => onSetFolders(true)} onNone={() => onSetFolders(false)} />
        <Stack gap="1.5">
          {folders.map((f) => (
            <Row
              key={f.name}
              label={f.name}
              count={f.count}
              active={enabledFolders.has(f.name)}
              onClick={() => onToggleFolder(f.name)}
            />
          ))}
        </Stack>
      </Box>

      <Box>
        <GroupHeader title="Languages" onAll={() => onSetLanguages(true)} onNone={() => onSetLanguages(false)} />
        <Stack gap="1.5">
          {languages.map((l) => (
            <Row
              key={l.key}
              label={l.label}
              count={l.count}
              color={l.color}
              active={enabledLanguages.has(l.key)}
              onClick={() => onToggleLanguage(l.key)}
            />
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck`
Expected: no NEW errors from `FiltersPanel.tsx` (Explorer errors from Task 5 may still be present until Task 7).

- [ ] **Step 3: Commit**

```bash
cd /c/Git/TSModuleScanner
git add components/FiltersPanel.tsx
git commit -m "Add FiltersPanel (folder + language toggles)"
```

---

## Task 7: Wire Explorer — state, derivation, funnel toggle, panel

**Files:**
- Modify: `components/Explorer.tsx`

- [ ] **Step 1: Add imports**

Add:

```ts
import {
  availableFolders,
  availableLanguages,
  DEFAULT_HIDDEN_LANGUAGES,
} from "@/lib/graph/filters";
import { FiltersPanel } from "./FiltersPanel";
```

- [ ] **Step 2: Add state**

After the `const [showExternal, setShowExternal] = useState(false);` line add:

```ts
  const [enabledFolders, setEnabledFolders] = useState<Set<string>>(() => new Set());
  const [enabledLanguages, setEnabledLanguages] = useState<Set<string>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
```

- [ ] **Step 3: Derive available lists + a reset helper**

After `const graph = result?.graph ?? null;` add:

```ts
  const folders = useMemo(() => (graph ? availableFolders(graph) : []), [graph]);
  const languages = useMemo(() => (graph ? availableLanguages(graph) : []), [graph]);

  const resetFileFilters = useCallback(
    (g: typeof graph) => {
      if (!g) return;
      setEnabledFolders(new Set(availableFolders(g).map((f) => f.name)));
      setEnabledLanguages(
        new Set(
          availableLanguages(g)
            .filter((l) => !DEFAULT_HIDDEN_LANGUAGES.has(l.key))
            .map((l) => l.key),
        ),
      );
    },
    [],
  );
```

- [ ] **Step 4: Initialize the sets when a graph loads**

In `handleResult`, after `setResult(res);` add `resetFileFilters(res.graph);` and add `resetFileFilters` to its dependency array. The callback becomes:

```ts
  const handleResult = useCallback(
    (res: AnalyzeResult, s: Stats) => {
      setResult(res);
      setStats(s);
      resetFileFilters(res.graph);
      setExpanded(new Set());
      setSelectedId(null);
      setSearch("");
    },
    [resetFileFilters],
  );
```

- [ ] **Step 5: Add toggle handlers**

Add near the other `handleToggle*` callbacks:

```ts
  const handleToggleFolder = useCallback((name: string) => {
    setEnabledFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleToggleLanguage = useCallback((key: string) => {
    setEnabledLanguages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSetFolders = useCallback(
    (on: boolean) => setEnabledFolders(on ? new Set(folders.map((f) => f.name)) : new Set()),
    [folders],
  );
  const handleSetLanguages = useCallback(
    (on: boolean) => setEnabledLanguages(on ? new Set(languages.map((l) => l.key)) : new Set()),
    [languages],
  );
```

- [ ] **Step 6: Include file filters in reset**

In `handleResetFilters`, add `resetFileFilters(graph);` and add `graph`, `resetFileFilters` to its dependency array.

- [ ] **Step 7: Add the Filters toggle button + pass props**

In the header `HStack` (next to the other buttons), add before the "Analyze another" button:

```tsx
        <Button
          size="sm"
          variant={filtersOpen ? "subtle" : "ghost"}
          colorPalette={filtersOpen ? "blue" : "gray"}
          onClick={() => setFiltersOpen((v) => !v)}
        >
          Filters
        </Button>
```

Pass the two new props to `<VelloGraphCanvas …>` (add alongside the existing `enabledRuntimes={enabledRuntimes}`):

```tsx
            enabledFolders={enabledFolders}
            enabledLanguages={enabledLanguages}
```

Render the panel: after the `<Box flex="1" minW="0" position="relative"> … </Box>` that holds `VelloGraphCanvas`, and before/after the `NodeDetailPanel`, add:

```tsx
        {filtersOpen && (
          <FiltersPanel
            folders={folders}
            languages={languages}
            enabledFolders={enabledFolders}
            enabledLanguages={enabledLanguages}
            onToggleFolder={handleToggleFolder}
            onToggleLanguage={handleToggleLanguage}
            onSetFolders={handleSetFolders}
            onSetLanguages={handleSetLanguages}
            onClose={() => setFiltersOpen(false)}
          />
        )}
```

- [ ] **Step 8: Verify typecheck + build + the existing component test**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck && bun test components/ && bun run build`
Expected: typecheck clean; component test(s) pass; static build OK.

- [ ] **Step 9: Commit**

```bash
cd /c/Git/TSModuleScanner
git add components/Explorer.tsx
git commit -m "Wire Filters panel: folder/language state, derivation, funnel toggle"
```

---

## Task 8: Clarify the left-sidebar node-type filters

**Files:**
- Modify: `components/Sidebar.tsx`

- [ ] **Step 1: Add a caption**

In `Sidebar.tsx`, inside the `<Section title="Node types" …>`, wrap the existing `<Stack gap="3">…</Stack>` so a caption precedes it. Change the opening to:

```tsx
      <Section title="Node types" modified={nodeTypesModified}>
        <Text fontSize="10px" color="fg.subtle" mb="2.5">
          Applies to symbols inside expanded files. To filter files, use the Filters panel (top-right).
        </Text>
        <Stack gap="3">
```

(The closing `</Stack>` and `</Section>` stay as-is.)

- [ ] **Step 2: Verify**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck && bun run format`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /c/Git/TSModuleScanner
git add components/Sidebar.tsx
git commit -m "Sidebar: note node-type filters apply to expanded files"
```

---

## Final verification

- [ ] **Full gate**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck && bun run lint && bun run format:check && bun test && bun run build`
Expected: typecheck clean; lint clean; format clean; **all tests pass** (existing 92 + ~13 new); static build OK.

- [ ] **Manual smoke (dev)**

`bun run dev`, scan a project that has a `target/` or `node_modules` (confirm they're gone), open the **Filters** panel: toggling a folder/language hides those file nodes instantly; JSON starts hidden and re-enables. Search a node name and confirm the view pans/zooms to the highlighted match.
