# TS Module Scanner

An interactive dependency-graph analyzer for TypeScript / JavaScript codebases. Drop in a
project folder and explore a node graph of its **modules, classes, interfaces, functions, and
React components** — and the relationships between them: imports, calls, inheritance, and JSX
component usage.

![node graph](docs/screenshot.png)

## Features

- **Four relationship types**
  - `import` — module dependency edges between files
  - `call` — **type-resolved** function/method call edges (resolved via the TypeScript
    compiler, so two functions named `handle` link to the correct definition)
  - `extends` / `implements` — class & interface inheritance
  - `renders` — which React component renders which (JSX usage)
- **Collapse to file level** by default; click a file to expand its classes, functions, and
  components. Edges into collapsed files aggregate to the file node automatically.
- **Filter** by relationship type, **search** nodes by name, and inspect any node's incoming
  and outgoing edges in a detail panel.
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

Open the app, drop a folder (or click **Choose folder**), and explore.

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

1. The browser reads `.ts/.tsx/.js/.jsx` files from the chosen folder (skipping
   `node_modules`, build output, and large files) into a `{ path: source }` map.
2. The map is POSTed to `/api/analyze`, which builds an **in-memory ts-morph project** and runs
   four isolated analyzers (`lib/analyzer/*`) that emit a shared `GraphModel`.
3. The client projects that model into a view (`lib/aggregate.ts`), lays it out with dagre
   (`lib/layout.ts`), and renders it with React Flow.

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
