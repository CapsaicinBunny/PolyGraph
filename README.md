<div align="center">

<img src="./public/polygraph-icon.svg" alt="PolyGraph" width="92" height="92" />

# PolyGraph

**Explore, audit, enforce, and compare software architecture across 26 languages.**

[![CI](https://github.com/CapsaicinBunny/PolyGraph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CapsaicinBunny/PolyGraph/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue)](#license)
&nbsp;
![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-000?logo=nextdotjs&logoColor=white)
![Rust](https://img.shields.io/badge/analysis%20core-Rust-DEA584?logo=rust&logoColor=white)
![WebGPU](https://img.shields.io/badge/renderer-WebGPU%20·%20Vello-005A9C)
![Languages](https://img.shields.io/badge/languages-26-8B5CF6)
![Local](https://img.shields.io/badge/100%25-local-16A34A)

</div>

Drop in a project folder and PolyGraph builds an interactive node graph of its modules, classes,
interfaces, structs, traits, functions, and components — and the relationships between them: imports,
calls, inheritance, instantiation, composition, dependency injection, and JSX component usage. Then
go further: trace impact, enforce architecture rules in CI, diff two revisions, query the graph,
export it, and jump straight to the source. It runs **entirely locally**.

Supports TypeScript/JavaScript, Python, Java, Kotlin, Rust, Go, Scala, C#, F#, C, C++, Objective-C,
Swift, Zig, Haskell, Ruby, PHP, Bash, Lua, Dart, Julia, R, Nix, OCaml, SQL, and WebAssembly text.

<div align="center">

<!--
  Replace docs/screenshots/demo.gif with a short (~10s) screen capture of the core loop:
  select a node → open its blast radius (impact) → view source evidence on an edge → open in editor.
  That communicates the value far better than a single full-project graph screenshot.
-->
<img src="docs/screenshots/demo.gif" alt="PolyGraph: select node → blast radius → source evidence → open in editor" width="100%" />

</div>

## What you can do

|                       |                                                                               |
| --------------------- | ----------------------------------------------------------------------------- |
| 🔎 **Explore**        | Interactive graph, smart layout, search, filters, focus mode                  |
| 🧭 **Analyze impact** | Dependencies, dependents, shortest path, blast radius, architectural insights |
| 🛡️ **Enforce**        | Architecture rules in CI (`polygraph check`) with SARIF output                |
| 🔀 **Compare**        | Diff two revisions / the working tree (`polygraph diff`)                      |
| 🗂️ **Abstract**       | Collapse to package- and workspace-level graphs from manifests                |
| 🧮 **Query**          | A small query language for selecting and isolating subgraphs                  |
| 📤 **Export**         | DOT, GraphML, Mermaid, JSON, SVG, standalone HTML report                      |
| ✏️ **Open in editor** | Inline source preview + jump to the exact line in VS Code / JetBrains         |

## The graph

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
- **Edge evidence & confidence** — every edge carries its occurrences (file · line · column ·
  provider) and a confidence (`exact` / `inferred` / `ambiguous`). Click an edge to see exactly
  where the relationship was observed, how many times, and the underlying symbol→symbol
  relationships behind an aggregated file edge. References PolyGraph **couldn't** resolve
  (unresolved imports, ambiguous resolutions) surface in the Problems panel.
- **Multi-framework + paradigm role detection** — tags nodes with a role (colored + badged),
  disambiguated by the file's extension and imports: **React** (JSX), **Vue** (`.vue` SFCs +
  `defineComponent`), **Svelte**, **Angular** (`@Component` / `@Injectable` / …), and **ECS**
  (`*Component` / `*System` / `*Entity`, `defineSystem` / `defineQuery`).
- **GPU vector renderer** — a Vello (Rust→WASM, WebGPU) canvas draws every card, edge, and label
  as a crisp GPU-rendered vector, with color-coded curved animated edges. Repeated relationships
  read as **thicker edges with a `×N` count**; pan/zoom stay smooth at thousands of nodes.
- **External dependencies** (toggle in the toolbar, off by default) — imported npm packages, Node
  builtins, and `Bun` / `Deno` / `process` API usage appear as dashed external nodes, color-coded
  by source family and enriched from `package.json` with **version** and dependency type
  (dependency / devDependency / peer / **undeclared**).
- **Light & dark mode**, **collapse-to-file** by default (expand a file to see its members),
  type/language/folder **filters**, **search**, and per-node **detail panels** (incoming/outgoing
  edges plus UI-vs-feature, client-vs-server, and runtime metadata).

## Smart layout

The default **Smart** layout (`semanticMultilevel`) goes beyond a single global graph:

- **Nested package containers** — visible group boxes by directory, package, or detected community.
- **Adaptive per-cluster layout** — each cluster is laid out with the engine that fits its shape.
- **Semantic reduction** — collapse strongly-connected components and chosen clusters to keep large
  graphs legible; aggregated edges keep their counts.
- **Edge routing & bundling** — optional orthogonal routing and community collapse (Settings pane).

Classic engines are still available: **Layered** and **Tree** (dagre; top-down / left-right /
bottom-up / right-left), plus **Radial**, **Circular**, **Grid**, and **Force-directed** (d3-force).
The view auto-fits on change.

## Impact analysis

Select any node and reason about blast radius and reachability:

- **Dependencies / dependents** at an adjustable depth (1–5).
- **Neighborhood**, **shortest path**, and **why-connected** between nodes.
- **Blast radius** — everything transitively affected, grouped by package / file / kind.
- **Problems / Insights panel** — clickable architectural findings, each opening a focused
  subgraph: cycles, fan-in/out hubs, bottlenecks, orphans, client→server violations, undeclared
  dependencies, deep dependency chains, instability (SDP), and unresolved/ambiguous references.

## Architecture rules (CI)

`polygraph check` turns the analyzer into an architectural guardrail. It loads `.polygraph.yml`,
scans the working tree, evaluates every rule and threshold, and **exits non-zero** if any
error-severity rule is violated — ready to drop into CI.

```bash
polygraph check .                    # human-readable report
polygraph check . --format sarif     # SARIF 2.1.0 for GitHub code scanning
polygraph check . --baseline main    # only fail on violations new vs. main
```

See [docs/CLI.md](docs/CLI.md) for the rule schema and full option reference.

## Graph diffing

`polygraph diff` compares two scans — revisions, branches, or the working tree — and reports what
changed in the architecture: added/removed nodes and edges, new or resolved cycles, and
blast-radius deltas. Useful in PR review.

```bash
polygraph diff .                     # working tree vs. HEAD
polygraph diff . --base main         # current branch vs. main
```

## Query language

A small text query language selects and isolates subgraphs, in the app's query bar or as saved
searches:

```
incoming:>5                                   # high fan-in modules
kind:function | kind:method  incoming:>0      # the public API surface
role:react-component                          # the React rendering tree
depends-on:"database"                         # anything reaching a "database" node
cycle:true                                    # nodes participating in a cycle
```

Supports fields (`kind`, `role`, `language`, `incoming`, `outgoing`, …), comparisons, boolean
`and`/`or`/`not`, grouping, `depends-on:` reachability, and `->` path queries. Presets ship for
common questions.

## Abstraction levels

Zoom out from files to architecture. PolyGraph reads project manifests
(`package.json`, `Cargo.toml`, `pyproject.toml`/`poetry`, `go.mod`, Maven, Gradle) and projects the
file graph up to **package** and **workspace** levels, so a monorepo's module boundaries and
cross-package dependencies become a single readable graph.

## Exports

Export the current graph for docs, diagrams, or other tools:

- **DOT** (Graphviz), **GraphML**, **Mermaid**, **JSON**
- **SVG** and a **standalone HTML report** (insights + figure, no external assets)
- **Saved workspaces** — capture the current view (filters, layout, camera, pins) to restore or
  share later.

## Editor integration

In the desktop app, a node's detail panel shows an inline **source preview** (syntax-highlighted
via Shiki) and an **Open in editor** action that jumps to the exact file and line in **VS Code** or
**JetBrains** IDEs. Source reads are constrained to the scanned project root.

## Getting started

```bash
bun install
bun run dev      # Next.js dev server → http://localhost:3003  ·  sidecar → http://localhost:4319
```

Open the app, paste an absolute folder path into **Scan a folder**, and explore. The sidecar reads
that folder directly from disk — nothing is uploaded or copied. (An in-browser folder picker is
also available as a fallback.)

> Requires a WebGPU-capable browser (recent Chrome or Edge) for the graph canvas.

### CLI

The same multi-language kernel powers a CLI (`check` / `diff`):

```bash
bun run cli/index.ts check .         # or, via the package "bin": polygraph check .
```

> The package is `"private": true` and the `polygraph` bin runs from this repo and inside the
> desktop app. Publishing to a registry for `bunx polygraph` / `npx polygraph` would require
> removing `"private"` and publishing the package.

## Scripts

```bash
bun run dev            # Next dev server (port 3003) + analysis sidecar (port 4319)
bun run build          # production build → static export in out/
bun run build:sidecar  # compile the sidecar to a standalone binary (dist/)
bun run start          # serve the static export locally (out/)
bun run check          # architecture rules check on the current directory
bun run diff           # graph diff of the current directory vs. HEAD
bun test               # analyzer + view unit tests
bun run lint           # oxlint
bun run format         # oxfmt
```

## How it works

For the full design — kernel, providers, the native Rust core, language packs, layouts, and the
renderer — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Two ways to feed it code:

- **Scan a path (default).** You give it an absolute folder path; the sidecar's `/scan` endpoint
  walks that directory on disk (`lib/server/scan-dir.ts`), skipping `node_modules`, build output,
  and large files, into a `{ path: source }` map. Nothing leaves your machine.
- **In-browser picker (fallback).** The browser reads the chosen folder's files into the same map
  and POSTs it to the sidecar's `/analyze` endpoint.

Either way, the map is fed to the **language kernel** (`analyzeProject()`, `lib/kernel/`), which
buckets files by extension and hands each to a provider that emits a shared `GraphModel`:

- **TypeScript / JavaScript** → a precise, ts-morph-backed provider (`lib/analyzer/`) with
  type-resolved calls and JSX component/renders detection.
- **Everything else** → declarative tree-sitter packs (`language-packs/<id>/`, a `pack.yaml` +
  `tags.scm`) run by a native Rust core (`analyzer-core/`, napi-rs). Adding a language is mostly a
  new pack folder.

The client projects the merged model into a view (`lib/aggregate.ts`), lays it out **off the main
thread** in a worker (`lib/layout.worker.ts`) — dagre for the layered/tree layouts, custom engines
for smart/radial/circular/grid/force — and renders it on a **Vello WebGPU vector canvas**
(`vello-renderer/`, Rust→WASM).

## Stack

| Concern       | Choice                                                              |
| ------------- | ------------------------------------------------------------------- |
| App           | Next.js (App Router, static export) + Chakra UI v3                  |
| Desktop       | Tauri v2 (optional desktop shell)                                   |
| Analysis      | Bun sidecar (`sidecar/server.ts`) over loopback                     |
| Runtime / PM  | Bun                                                                 |
| Graph render  | Vello (Rust→WASM, WebGPU) vector renderer                           |
| Layout        | dagre (layered/tree) + custom engines (smart/radial/…), in a worker |
| Code analysis | ts-morph (TS/JS) + native tree-sitter core (Rust, napi-rs)          |
| Lint / format | oxlint / oxfmt                                                      |

## Project layout

```
lib/
  graph/types.ts        shared GraphModel types + id helpers (incl. edge evidence)
  graph/visual.ts       colors / glyphs / icons per node & edge kind
  graph/query.ts        impact analysis: dependencies/dependents/blast radius/paths
  graph/insights.ts     architectural-issue detectors (Problems panel)
  graph/query-language/ the search/select query language (tokenize/parse/evaluate)
  graph/levels/         package- & workspace-level projection
  kernel/               language kernel: provider interface, registry, tree-sitter glue
  analyzer/             ts-morph TypeScript/JS provider (the precise plugin)
  server/handlers.ts    framework-agnostic runScan / runAnalyze
  server/manifests/     manifest discovery (npm/cargo/go/python/maven/gradle)
  aggregate.ts          collapse/expand view projection (+ edge aggregation)
  layout.ts             layout engines (+ layout.worker.ts off-main-thread)
  cli · config · rules · glob · diff   CLI: check + diff, rules engine, SARIF
  export · workspace · editor          exports, saved workspaces, editor jump
language-packs/         declarative tree-sitter packs (one folder per language)
analyzer-core/          native Rust (napi-rs) tree-sitter analysis core
vello-renderer/         Rust→WASM WebGPU vector renderer
sidecar/server.ts       Bun analysis sidecar (loopback endpoints /scan and /analyze)
cli/index.ts            the polygraph CLI entrypoint
src-tauri/              Tauri v2 desktop shell
app/page.tsx            renders the Explorer (static-exported SPA)
components/             Explorer, VelloGraphCanvas, Sidebar, NodeDetailPanel, panels
```

## Releases & security

See [docs/RELEASING.md](docs/RELEASING.md) for how desktop installers are built, and
[SECURITY.md](SECURITY.md) for tracked advisories — notably the Linux-only `glib 0.18.5`
RustSec advisory ([RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429), blocked
upstream on Tauri's GTK4 migration; see [#4](https://github.com/CapsaicinBunny/PolyGraph/issues/4)).

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for
inclusion in this project by you, as defined in the Apache-2.0 license, shall be dual
licensed as above, without any additional terms or conditions.
