# TS Module Scanner

An interactive dependency-graph analyzer for TypeScript / JavaScript codebases. Drop in a
project folder and explore a node graph of its **modules, classes, interfaces, functions, and
React components** — and the relationships between them: imports, calls, inheritance, and JSX
component usage.

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
- **Paradigm role detection** — scans for architecture across paradigms and tags nodes with a
  role (colored + badged): `react-component`, and ECS `ecs-component` / `ecs-system` /
  `ecs-entity`, detected from naming (`*Component`/`*System`/`*Entity`), decorators
  (`@Component`/`@System`/`@Entity`), and data-oriented factories (`defineComponent`,
  `defineSystem`, `defineQuery`).
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

| Concern       | Choice                                      |
| ------------- | ------------------------------------------- |
| Framework     | Next.js (App Router)                        |
| Runtime / PM  | Bun                                         |
| UI            | Chakra UI v3                                |
| Graph         | React Flow (`@xyflow/react`) + dagre layout |
| Code analysis | ts-morph (TypeScript compiler)              |
| Lint / format | oxlint / oxfmt                              |

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

Two ways to feed it code:

- **Scan a path (default).** You give it an absolute folder path; `/api/scan` walks that
  directory on the server's filesystem (`lib/server/scan-dir.ts`), skipping `node_modules`,
  build output, and large files, into a `{ path: source }` map. Nothing leaves your machine.
- **In-browser picker (fallback).** The browser reads the chosen folder's files into the same
  map and POSTs it to `/api/analyze`.

Either way, the map is fed to `analyzeSources()`, which builds an **in-memory ts-morph project**
and runs four isolated analyzers (`lib/analyzer/*`) that emit a shared `GraphModel`. The client
projects that model into a view (`lib/aggregate.ts`), lays it out with dagre (`lib/layout.ts`),
and renders it with React Flow.

The analyzer layer is intentionally decoupled from the UI behind a single
`analyzeSources(files) → GraphModel` boundary, so the parsing engine could later be swapped
(e.g. for the native Go `tsgo` compiler once it exposes a comparable API).

## Project layout

```
lib/
  graph/types.ts      shared GraphModel types + id helpers
  graph/visual.ts     colors / labels per node & edge kind
  analyzer/           in-memory project + the four sub-analyzers + composer
  aggregate.ts        collapse/expand view projection
  layout.ts           dagre layout
  client/read-files.ts browser folder reader
app/
  page.tsx            renders the Explorer
  api/analyze/route.ts analysis endpoint (Node.js runtime)
components/           Explorer, GraphCanvas, Sidebar, NodeDetailPanel, UploadDropzone, nodes/
```
