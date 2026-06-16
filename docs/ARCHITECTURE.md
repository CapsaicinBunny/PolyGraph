# PolyGraph — Architecture

PolyGraph scans a codebase across ~25 languages and renders an interactive node graph of its
modules, types, functions, and the relationships between them (imports, calls, inheritance,
composition, instantiation, JSX renders). It runs entirely locally.

## Pipeline

```
folder ─▶ sidecar (server fs) ─▶ kernel ─▶ providers ─▶ GraphModel
                                                        │
                              aggregate (collapse/expand view)
                                                        │
                              layout (dagre, off-main-thread worker)
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
   (`lib/aggregate.ts`), lays it out with dagre on a Web Worker (`lib/layout.worker.ts`).
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

## Native analysis core (`analyzer-core/`)

A napi-rs addon (`analyze(grammar, query, importStyle, filesJson) → json`). Built with
`cd analyzer-core && napi build --release`; the prebuilt `analyzer-core.node` is committed so the
app runs without a Rust toolchain. It's loaded via `process.dlopen` by absolute path
(`lib/kernel/treesitter/core.ts`) — not `require`, which webpack would try to bundle.

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

## Rendering (`vello-renderer/`)

A Rust→WASM crate exposing `VelloCanvas` (WebGPU). It draws cards (light, color-coded left edge,
tinted icon chip), curved animated edges colored by relation, GPU-rendered text labels, and a
language badge inside each file node. Pan/zoom/selection/search update a single GPU scene, so it
stays smooth at thousands of nodes. Loaded client-side via dynamic import (WebGPU is browser-only).

## Project layout

```
lib/
  graph/types.ts        universal GraphModel + id helpers
  graph/visual.ts       colors / glyphs / icons / layers / language badges
  graph/scene.ts        geometry-free scene (shared by layout + renderer)
  kernel/               language kernel: provider interface, registry, tree-sitter glue
  analyzer/             ts-morph TypeScript/JS provider (the precise plugin)
  aggregate.ts          collapse/expand view projection
  layout.ts             dagre layouts (+ layout.worker.ts off-main-thread)
language-packs/         declarative tree-sitter packs (one folder per language)
analyzer-core/          native Rust (napi-rs) tree-sitter core (+ vendor/wat)
vello-renderer/         Rust→WASM WebGPU vector renderer
app/
  page.tsx              renders the Explorer (static-exported SPA)
sidecar/server.ts       Bun loopback server hosting /scan and /analyze
lib/server/handlers.ts  framework-agnostic runScan / runAnalyze
components/             Explorer, UploadDropzone, VelloGraphCanvas, Sidebar, NodeDetailPanel
```
