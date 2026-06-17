# Graph filtering panel + search-to-focus

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation

## Problem

1. **Filters feel broken.** The left-sidebar node-type chips (Class, Function, …) only affect *symbol* nodes, which appear only when a file is expanded. At the default file-collapsed view every node is a `file`, and files are always visible (`scene.ts` `visible()` returns `true` for `kind === "file"`), so toggling types does nothing. There is no way to filter the file nodes that dominate the view.
2. **Build-folder noise.** `IGNORE_DIR` doesn't exclude `target/` (Cargo) and similar, and `SOURCE_EXT` includes `.json`, so scanning a Rust project pulls in thousands of `target/.../lib-*.json` fingerprint files.
3. **Search gives no feedback when zoomed out.** Search paints a yellow outline on matches, but if the match is off-screen or sub-pixel (zoomed out) it looks like nothing happened.

## Design

### 1. Scan hygiene — `lib/file-filters.ts`
Extend `IGNORE_DIR` with common build/dependency/generated dirs: `target`, `.venv`, `venv`, `__pycache__`, `vendor`, `bin`, `obj`, `.gradle`, `Pods`, `.dart_tool`, `.svelte-kit`, `.nuxt`, `.idea`, `.vscode`. Keep `.json` in `SOURCE_EXT` (still scanned) — JSON is hidden by default in the UI (re-enableable), not dropped.

### 2. Right-side Filters panel — `components/FiltersPanel.tsx` (new)
A collapsible panel on the right, toggled by a funnel button in the `Explorer` header (independent of the left sidebar and of the node-detail panel; it slides in/out). Two toggle groups, derived from the loaded graph's file nodes:

- **Folders** — the distinct **top-level path segments** (`src`, `lib`, `components`, …) with per-folder file counts and *All / None* shortcuts. Files at the repo root group under a `/ (root)` entry. Deselecting a folder hides every file under it.
- **Languages** — the languages present (from `languageBadge(filename)`), each a toggle showing its badge + count. **JSON (`.json`/`.jsonc`) defaults to OFF**; every other language defaults ON. Re-enable JSON here at any time.

### 3. Filtering model — `Explorer.tsx` + `lib/graph/scene.ts`
`Explorer` derives, from `graph.nodes` (file nodes), the available folders and languages, and holds two new state sets: `enabledFolders` and `enabledLanguages` (init: all folders on; all languages on except `json`). They're added to `SceneFilters`. In `scene.ts` `visible()`, a `file` node is shown only when its top-level folder ∈ `enabledFolders` **and** its language ∈ `enabledLanguages`. Hiding a file cascades to its symbols/edges via the existing `parentFile`/edge-endpoint pruning. The signature string includes the two new sets so layout caching stays correct. Helpers: `topFolderOf(path)` and a language key derived from the filename (reuse `languageBadge`).

The left sidebar's node-type/relationship filters are unchanged; they continue to apply to expanded symbols. Add a one-line caption under the NODE TYPES heading: *"applies to expanded files"* to remove the confusion.

### 4. Search-to-focus — `components/VelloGraphCanvas.tsx`
The search effect already calls `set_search(query)` (yellow outline). Add: when `search` is non-empty, compute the matching **visible** scene nodes (`label.toLowerCase().includes(query)`), take their world-space bounding box, and `set_camera` to frame it — centered, scaled to fit the viewport with padding, **clamped so a single match doesn't zoom to max** (cap at ~1.2×). Keep the yellow outline. No match → leave the camera as-is. Clearing the search leaves the camera where it is (no jarring re-fit). This is pure TS using the existing scene positions + canvas size (`clientWidth/Height × dpr`); no Vello/WASM change.

## Components / files
- Modify: `lib/file-filters.ts`, `lib/graph/scene.ts`, `components/Explorer.tsx`, `components/Sidebar.tsx` (the caption), `components/VelloGraphCanvas.tsx`.
- Create: `components/FiltersPanel.tsx`.

## Testing
- `lib/file-filters.test.ts` (new): `target/…/lib-x.json` and `.venv/…`, `bin/obj/…` are ignored; ordinary `src/foo.ts` is not.
- `lib/graph/scene.test.ts` (new or extend): file hidden when its top folder/language is disabled (and its symbols/edges drop); JSON hidden by default.
- Search-focus camera math: extract the bbox→camera computation into a pure helper (e.g. `frameNodes(nodes, viewport)`) and unit-test it (centers/clamps correctly); the canvas wiring itself stays untested (WebGPU).

## Out of scope
- Nested folder tree (top-level segments only).
- Smooth camera tween (instant `set_camera` is fine).
- Server-side re-scan from the panel (filtering is client-side on the loaded graph).
