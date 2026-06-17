# PolyGraph — Architecture

PolyGraph scans a codebase across 26 languages and renders an interactive node graph of its
modules, types, functions, and the relationships between them (imports, calls, inheritance,
composition, instantiation, dependency injection, JSX renders). On top of the graph it offers
impact analysis, a query language, package/workspace abstraction levels, architecture-rule
enforcement and diffing (CLI), exports, and editor integration. It runs entirely locally.

## Pipeline

```
folder ─▶ sidecar (server fs) ─▶ kernel ─▶ providers ─▶ GraphModel
                                                        │
                              aggregate (collapse/expand view + edge aggregation)
                                                        │
                              scene (geometry-free, lib/graph/scene.ts)
                                                        │
                              layout (worker: dagre for layered/tree, custom engines otherwise)
                                                        │
                              Vello WebGPU canvas (GPU-drawn vectors)
```

1. **Input** — the React client sends the folder path (or, on the web fallback, a
   read-in-browser file map) to the **Bun analysis sidecar** (`sidecar/server.ts`),
   a loopback HTTP server hosting `/scan` and `/analyze`. The sidecar calls the
   shared handlers (`lib/server/handlers.ts`); scan reads the path from disk —
   nothing is uploaded.
2. **Kernel** (`lib/kernel/`) — buckets files by extension and runs every matching language
   **provider concurrently** (`Promise.all`), then merges their universal-IR fragments,
   de-duplicates, and drops edges to unknown nodes.
3. **View + layout** — the client projects the merged `GraphModel` into a collapse/expand view
   (`lib/aggregate.ts`), builds a geometry-free scene (`lib/graph/scene.ts`), and lays it out on a
   Web Worker (`lib/layout.worker.ts`).
4. **Render** — a Vello (Rust→WASM, WebGPU) canvas (`vello-renderer/`) draws cards, edges, and
   text as GPU vectors, scaling to thousands of nodes.

## The language kernel & providers

The kernel is decoupled from the UI behind one boundary: `analyzeProject(files) → GraphModel`.
Each language is a **provider plugin** (`lib/kernel/provider.ts`); the registry
(`lib/kernel/registry.ts`) lists them. Two kinds:

- **TypeScript / JavaScript** → a precise, **ts-morph**-backed provider (`lib/analyzer/`). Uses the
  TypeScript type checker for type-resolved call edges, JSX component/renders detection,
  framework + paradigm roles (React / Vue / Svelte / Angular / ECS), and JSDoc
  `@typedef`/`@callback` nodes.
- **Everything else** → declarative **tree-sitter packs** run by a native Rust core
  (`analyzer-core/`). A provider can start as a declarative pack and later graduate to a precise
  code-backed provider without changing anything else — that's the point of the plugin boundary.

A single provider throwing (e.g. a malformed pack query) is caught and surfaced as an error
rather than failing the whole analysis.

### Edge evidence

Every edge carries `occurrences` (file · line · column · provider) plus a `count` and a
`confidence` (`exact` / `inferred` / `ambiguous`), defined in `lib/graph/types.ts`. The ts-morph
provider records exact source positions; the native core emits positions per language pack.
Occurrences are capped per edge (`OCCURRENCE_CAP`) with an exact total `count`. Aggregation
(`lib/aggregate.ts`) merges evidence when symbol→symbol edges collapse onto a file→file edge, and
keeps the underlying edge ids so the UI can show "what's behind this edge". The TS analyzer also
emits an `unresolved` list (references it could not resolve, e.g. broken relative imports) carried
through `AnalyzeResult` to the Problems panel.

## Native analysis core (`analyzer-core/`)

A napi-rs addon (`analyze(grammar, query, importStyle, filesJson) → json`). Built with
`cd analyzer-core && bunx @napi-rs/cli build --release`; the prebuilt `analyzer-core.node` is
committed so the app runs without a Rust toolchain. It's loaded via `process.dlopen` by absolute
path (`lib/kernel/treesitter/core.ts`) — not `require`, which webpack would try to bundle.

- Runtime: **tree-sitter 0.25** (supports grammar ABI 13–15, so current maintained grammars are
  drop-in via `LANGUAGE.into()`).
- A grammar must depend on `tree-sitter-language` (version-agnostic). Grammars with a direct
  `tree-sitter` dependency conflict with the pinned runtime.
- WebAssembly text (`.wat`) has no published crate, so the grammar's generated `parser.c` is
  **vendored** in `analyzer-core/vendor/wat/` and compiled by `build.rs` via `cc`.

### Resolution

- **Python** uses dotted/relative module resolution against the scanned file set.
- Every other language uses **by-name** resolution: references resolve against a global
  unique-definer index (separator-agnostic for `.`/`::`/`/`), so same-scope refs without an
  import still link.

## Language packs (`language-packs/<id>/`)

A pack is purely declarative:

- `pack.yaml` — id, extensions, grammar name, import style.
- `tags.scm` — a tree-sitter query using the standard capture convention:
  `@definition.<kind>` + `@name`, `@reference.<rel>` + `@name`, `@import` + `@module`
  (+ optional `@import.name`).

**Adding a language:** drop in a pack folder, add its id to `TREE_SITTER_PACKS`, add its
extensions to `lib/file-filters.ts`, then add `"<id>" => Some(tree_sitter_<lang>::LANGUAGE.into())`
to `language_for` in the core and rebuild the `.node`.

## Node taxonomy & emission

`NodeKind` (`lib/graph/types.ts`) is universal/language-neutral: class, interface, struct, trait,
protocol, enum, union, record, object, type, namespace, module, function, method, constructor,
accessor, component, macro, variable, constant, field, property, annotation (+ file, external).
Each parser emits the subset that fits. Every kind has a color/glyph/icon in `lib/graph/visual.ts`
and belongs to a filter **layer** (Types / Callables / Members / Modules) shown in the sidebar.

In the Rust core, members (method/field/property/…) and containers always become nodes; free
functions/variables/constants emit only at the top level (locals fold). Modules/namespaces are
non-absorbing, so items inside a `mod` stay separate nodes. References attribute to the innermost
enclosing emitted symbol. Files are collapsed by default, so member-level detail only appears when
a file is expanded.

## Layout (`lib/layout.ts`, `lib/layout/`)

Layout runs **off the main thread** in `lib/layout.worker.ts`, keyed by a scene signature so an
unchanged scene reuses its positions. Several engines back the `LayoutAlgorithm` enum:

- **smart** (`semanticMultilevel`) — the default. Nested package/community containers, adaptive
  per-cluster layout, strongly-connected-component collapse, semantic reduction, and optional
  edge routing/bundling. See `lib/layout/` (community detection, scc, smart).
- **layered**, **tree** — dagre, with top-down / left-right / bottom-up / right-left directions.
- **radial**, **circular**, **grid**, **force** — custom engines (force uses d3-force).

So the view is **not** laid out exclusively through dagre: dagre powers the layered/tree
algorithms, while smart/radial/circular/grid/force have their own engines.

## Impact analysis & insights

- `lib/graph/query.ts` — pure graph algorithms: `dependencies`, `dependents`, `neighborhood`,
  `shortestPath`, `whyConnected`, and `blastRadius` (grouped by package/file/kind), over a
  prebuilt adjacency.
- `lib/graph/insights.ts` — architectural-issue detectors producing clickable findings (cycles,
  fan-in/out, bottlenecks, orphans, client→server violations, undeclared deps, deep chains,
  instability/SDP, ambiguous resolutions) plus unresolved-reference findings. Each finding's
  `nodeIds` define a focused subgraph the UI opens (`components/ProblemsPanel.tsx`).

## Query language (`lib/graph/query-language/`)

A small text query language for selecting/isolating subgraphs: `tokenize` → `parse` →
`evaluate` over the graph + computed `metrics`. Supports fields (`kind`, `role`, `language`,
`incoming`, `outgoing`, …), comparisons, boolean `and`/`or`/`not`, grouping, `depends-on:`
reachability, and `->` path queries. `presets.ts` ships common queries; the UI exposes it as the
query bar with saved searches.

## Abstraction levels (`lib/graph/levels/`, `lib/server/manifests/`)

`lib/server/manifests/` discovers project manifests (npm/cargo/go/python/maven/gradle), including a
small hand-rolled TOML parser (`toml.ts`) for Cargo/pyproject. `lib/graph/levels/packages.ts`
projects the file-level `GraphModel` up to **package** and **workspace** levels using the nearest
enclosing manifest, aggregating cross-package edges. The scan/analyze responses carry the
discovered manifests so the client can switch levels without re-scanning.

## CLI: architecture rules & diff (`cli/`, `lib/cli/`, `lib/rules/`, `lib/diff/`)

The same kernel powers a CLI (`cli/index.ts`):

- **`check`** — loads `.polygraph.yml` (`lib/config/`), evaluates rules/thresholds
  (`lib/rules/engine.ts`, selectors, glob matching in `lib/glob/`), and reports human-readable or
  **SARIF 2.1.0** (`lib/rules/sarif.ts`). Exits non-zero on error-severity violations; `--baseline`
  fails only on violations new vs. a git ref.
- **`diff`** — compares two scans / revisions / the working tree (`lib/diff/diff.ts`) and reports
  added/removed nodes and edges, cycle changes, and blast-radius deltas.

See [CLI.md](CLI.md) for the full surface.

## Exports & workspaces (`lib/export/`, `lib/workspace/`)

- `lib/export/` — serializes the graph to DOT, GraphML, Mermaid, JSON, SVG, and a standalone HTML
  report (escaping handled per format). `lib/client/download.ts` triggers the browser download.
- `lib/workspace/` — captures/restores a view state (filters, layout, camera, pins) as a versioned
  workspace, persisted via `store.ts`.

## Editor integration (`lib/editor/`, `components/SourcePreview.tsx`, `src-tauri/`)

Desktop-only. `components/SourcePreview.tsx` shows a Shiki-highlighted slice of the source for a
selected node; `lib/editor/commands.ts` builds **VS Code** / **JetBrains** open-at-line commands.
The Tauri shell (`src-tauri/src/lib.rs`) exposes `read_source_slice` (reads constrained to the
scanned project root via canonicalized path check) and `spawn_detached` (argv array — no shell, so
no injection).

## Rendering (`vello-renderer/`)

A Rust→WASM crate exposing `VelloCanvas` (WebGPU). It draws cards (light, color-coded left edge,
tinted icon chip), curved animated edges colored by relation — thicker with a `×N` label for
aggregated relationships, falling back to solid strokes past an edge budget to bound dash
tessellation — GPU-rendered text labels, and a language badge inside each file node.
Pan/zoom/selection/search and edge picking update a single GPU scene, so it stays smooth at
thousands of nodes. Loaded client-side via dynamic import (WebGPU is browser-only).

## Project layout

```
lib/
  graph/types.ts          universal GraphModel + id helpers (+ edge evidence)
  graph/visual.ts         colors / glyphs / icons / layers / language badges
  graph/scene.ts          geometry-free scene (shared by layout + renderer)
  graph/query.ts          impact analysis (dependencies/dependents/blast radius/paths)
  graph/insights.ts       architectural-issue detectors (Problems panel)
  graph/query-language/   search/select query language (tokenize/parse/evaluate/metrics)
  graph/levels/           package- & workspace-level projection
  kernel/                 language kernel: provider interface, registry, tree-sitter glue
  analyzer/               ts-morph TypeScript/JS provider (the precise plugin)
  aggregate.ts            collapse/expand view projection (+ edge aggregation)
  layout.ts, layout/      layout engines (+ layout.worker.ts off-main-thread)
  server/handlers.ts      framework-agnostic runScan / runAnalyze
  server/manifests/       manifest discovery (npm/cargo/go/python/maven/gradle)
  cli/, config/, rules/, glob/, diff/   CLI: check + diff, rules engine, SARIF
  export/, workspace/, editor/          exports, saved workspaces, editor jump
language-packs/           declarative tree-sitter packs (one folder per language)
analyzer-core/            native Rust (napi-rs) tree-sitter core (+ vendor/wat)
vello-renderer/           Rust→WASM WebGPU vector renderer
cli/index.ts              polygraph CLI entrypoint
src-tauri/                Tauri v2 desktop shell
app/
  page.tsx                renders the Explorer (static-exported SPA)
sidecar/server.ts         Bun loopback server hosting /scan and /analyze
components/               Explorer, UploadDropzone, VelloGraphCanvas, Sidebar, panels
```
