# PolyGraph

An interactive dependency-graph analyzer for codebases across **~25 languages** — TypeScript/
JavaScript, Python, Java, Kotlin, Rust, Go, Scala, C#, F#, C, C++, Objective-C, Swift, Zig,
Haskell, Ruby, PHP, Bash, Lua, Dart, Julia, R, Nix, OCaml, SQL, and WebAssembly. Drop in a
project folder and explore a node graph of its modules, classes, interfaces, structs, traits,
functions, and components — and the relationships between them: imports, calls, inheritance,
instantiation, and JSX component usage.

![node graph](docs/screenshot.png)

## Features

- **Relationship types** (drawn automatically, no configuration)
  - `import` — module dependency edges between files
  - `call` — **type-resolved** function/method call edges (resolved via the TypeScript
    compiler, so two functions named `handle` link to the correct definition)
  - `instantiates` — `new X()` construction edges
  - `extends` / `implements` — class & interface inheritance
  - `has` — composition: a typed field/property referencing another class or interface
    (resolved through arrays and generics)
  - `injects` — dependency injection: constructor parameter types
  - `renders` — which React component renders which (JSX usage)
- **Multi-framework + paradigm role detection** — scans for architecture and tags nodes with a
  role (colored + badged), disambiguated by the file's extension and imports:
  - **React** components (JSX)
  - **Vue** — `.vue` SFCs (the embedded `<script>` is analyzed) and `defineComponent`
  - **Svelte** — `.svelte` components
  - **Angular** — `@Component` / `@Directive` / `@Pipe` / `@Injectable` / `@NgModule`
  - **ECS** — `ecs-component` / `ecs-system` / `ecs-entity` from naming (`*Component`/`*System`/
    `*Entity`), lowercase decorators, and `defineSystem` / `defineQuery` (in a bitECS context)
- **GPU vector renderer** — a Vello (Rust→WASM, WebGPU) canvas draws every card, edge, and
  label as a crisp GPU-rendered vector, with color-coded curved animated edges and pan/zoom
  that stay smooth at thousands of nodes.
- **External dependencies** (toggle in the toolbar, off by default) — imported npm packages,
  Node builtins, and `Bun` / `Deno` / `process` API usage appear as dashed external nodes,
  color-coded by source family (npm / Node / Deno / Bun); edges into them are tinted to match.
  npm subpath imports collapse to one node per package, and when scanning a path the node is
  enriched from `package.json` with its **version** and dependency type (dependency /
  devDependency / peer / **undeclared** — handy for spotting missing deps).
- **Layout algorithms** — Layered and Tree (dagre, with top-down / left-right / bottom-up /
  right-left directions, Mermaid-style), plus Radial, Circular, Grid, and Force-directed
  (d3-force). The view auto-fits on change.
- **Collapse to file level** by default; click a file to expand its classes, functions, and
  components. Edges into collapsed files aggregate to the file node automatically.
- **Filter** by relationship type, **search** nodes by name, and inspect any node in a detail
  panel — incoming/outgoing edges plus detected metadata: **UI vs feature**, **client vs
  server** (`"use client"` / `"use server"`), and **runtime** (Node / Deno / Bun, inferred from
  `node:`/builtin imports and `Bun`/`Deno`/`process` usage).
- Runs entirely locally — files are read in your browser and analyzed by a Next.js API route.
  Nothing is persisted or sent anywhere else.

## Stack

| Concern       | Choice                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| Framework     | Next.js (App Router)                                                        |
| Runtime / PM  | Bun                                                                         |
| UI            | Chakra UI v3                                                                |
| Graph         | Vello (Rust→WASM, WebGPU) vector renderer + dagre layout                    |
| Code analysis | ts-morph (TS/JS) + native tree-sitter core (Python, Java, Kotlin, Rust, Go) |
| Lint / format | oxlint / oxfmt                                                              |

## Getting started

```bash
bun install
bun run dev      # http://localhost:3000
```

Open the app, paste an absolute folder path into **Scan a folder on this machine**, and
explore. The local server reads that folder directly from disk — nothing is uploaded or copied.
(An in-browser folder picker is also available as a fallback.)

## Scripts

```bash
bun run dev          # start the dev server
bun run build        # production build
bun run start        # serve the production build
bun test             # run the analyzer + view unit tests
bun run lint         # oxlint
bun run format       # oxfmt
```

## How it works

For the full design — kernel, providers, the native Rust core, language packs, and the renderer —
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Two ways to feed it code:

- **Scan a path (default).** You give it an absolute folder path; `/api/scan` walks that
  directory on the server's filesystem (`lib/server/scan-dir.ts`), skipping `node_modules`,
  build output, and large files, into a `{ path: source }` map. Nothing leaves your machine.
- **In-browser picker (fallback).** The browser reads the chosen folder's files into the same
  map and POSTs it to `/api/analyze`.

Either way, the map is fed to the **language kernel** (`analyzeProject()`, `lib/kernel/`), which
buckets files by extension and hands each to a provider that emits a shared `GraphModel`:

- **TypeScript / JavaScript** → a precise, ts-morph-backed provider (`lib/analyzer/`) with
  type-resolved calls and JSX component/renders detection.
- **Python, Java, Kotlin, Rust, Go** → declarative tree-sitter packs (`language-packs/<id>/`,
  a `pack.yaml` + `tags.scm`) run by a native Rust core (`analyzer-core/`, napi-rs). Adding a
  language is mostly a new pack folder.

The client projects the merged model into a view (`lib/aggregate.ts`), lays it out with dagre
off the main thread (`lib/layout.worker.ts`), and renders it on a **Vello WebGPU vector canvas**
(`vello-renderer/`, Rust→WASM) — cards, edges, and text are GPU-drawn vectors, so it stays smooth
at thousands of nodes.

The kernel is decoupled from the UI behind a single `analyzeProject(files) → GraphModel`
boundary, and each language is a plugin: a declarative pack, or a precise code-backed provider
like ts-morph.

## Project layout

```
lib/
  graph/types.ts      shared GraphModel types + id helpers
  graph/visual.ts     colors / labels per node & edge kind
  kernel/             language kernel: provider interface, registry, tree-sitter glue
  analyzer/           ts-morph TypeScript/JS provider (the precise plugin)
  aggregate.ts        collapse/expand view projection
  layout.ts           dagre layout (+ layout.worker.ts off-main-thread)
  client/read-files.ts browser folder reader
language-packs/       declarative tree-sitter packs (python, java, kotlin, rust, go)
analyzer-core/        native Rust (napi-rs) tree-sitter analysis core
vello-renderer/       Rust→WASM WebGPU vector renderer
app/
  page.tsx            renders the Explorer
  api/analyze/route.ts analysis endpoint (Node.js runtime)
components/           Explorer, VelloGraphCanvas, Sidebar, NodeDetailPanel, UploadDropzone
```
