# TS Module Scanner — Design

**Date:** 2026-06-15
**Status:** Approved

## Summary

A web app that scans a TypeScript/JavaScript codebase (`.ts`, `.tsx`, `.js`, `.jsx`) and
renders an interactive node graph of its structure: modules, classes, functions, and React
components, plus the relationships between them (imports, calls, inheritance, component usage).

## Stack

- **Next.js** (App Router) — UI + API routes
- **Bun** — runtime, package manager, test runner
- **Chakra UI v3** — component library / theming
- **React Flow** — node graph rendering
- **ts-morph** — TypeScript compiler wrapper for accurate AST + symbol analysis
- **dagre** — automatic graph layout
- **oxlint** + **oxfmt** — linting and formatting

### Note on TS7 / tsgo

The native Go TypeScript compiler (`tsgo`, "TS7") does not yet expose a high-level
programmatic AST/symbol API comparable to ts-morph. ts-morph (wrapping the standard TS
compiler) is used for analysis. The analyzer layer is isolated behind a single
`(Project) → GraphModel` boundary so the parsing engine can be swapped later with no UI
changes.

## User Flow

1. **Upload** — The user picks or drag-drops a folder via a `webkitdirectory` input. The
   browser reads every `.ts/.tsx/.js/.jsx` file's contents into an in-memory map
   `{ [relativePath]: sourceText }`. `node_modules`, `.git`, build output, and common ignore
   patterns are filtered client-side before upload.
2. **Analyze** — The map is POSTed to `/api/analyze`. The route runs ts-morph and returns a
   `GraphModel` JSON.
3. **Render** — The client renders the `GraphModel` with React Flow: Chakra-styled custom
   nodes color-coded by kind, auto-laid-out with dagre, with filtering, search, and a detail
   panel.

## Analysis (server-side, Bun)

ts-morph builds an **in-memory project** (`useInMemoryFileSystem: true`) from the uploaded
files, so no disk access is needed. Four isolated sub-analyzers each contribute to one shared
`GraphModel`:

- **imports** — module dependency edges between files (`import` / `export ... from` /
  dynamic `import()` / `require`). Edge kind: `import`.
- **calls** — function/method call edges. **Type-resolved**: each `CallExpression` is resolved
  to its definition via ts-morph symbol/definition lookup, so calls link to the exact target
  function/method (not a name-match heuristic). Calls to symbols outside the uploaded set are
  dropped. Edge kind: `call`.
- **inheritance** — `extends` / `implements` edges between classes and interfaces. Edge kinds:
  `extends`, `implements`.
- **components** — React component render-usage edges, detected from JSX elements whose tag
  resolves to a component declared in the project. Edge kind: `renders`.

Each sub-analyzer is a pure function `(Project, ctx) → { nodes, edges }`. A composer merges
them, de-duplicates nodes by stable id, and returns the `GraphModel`.

### GraphModel (shared types — `lib/graph/types.ts`)

```ts
type NodeKind = "file" | "class" | "interface" | "function" | "component";
type EdgeKind = "import" | "call" | "extends" | "implements" | "renders";

interface GraphNode {
  id: string; // stable: `${filePath}#${symbolName}` (or filePath for files)
  kind: NodeKind;
  label: string; // display name
  filePath: string;
  line: number; // declaration line (1-based)
  parentFile: string; // owning file id, for collapse/expand
}

interface GraphEdge {
  id: string; // `${source}->${target}:${kind}`
  source: string; // node id
  target: string; // node id
  kind: EdgeKind;
}

interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

## Scale handling — collapse to file level

To stay readable on large repos:

- The graph **defaults to file/module nodes only**, with edges aggregated to the file level
  (a call from a function in A to one in B shows as an A→B edge, deduped, kind-tagged).
- **Expanding a file** node reveals its child symbol nodes (classes/functions/components) and
  the precise symbol-level edges within and to/from it.
- Aggregation and the file→symbol parent mapping are derived from `GraphNode.parentFile`.

## UI Components

- `UploadDropzone` — folder picker + drag-drop, client-side filtering, progress, POSTs to API.
- `GraphCanvas` — React Flow wrapper: custom node types per `NodeKind`, dagre layout, minimap,
  pan/zoom, expand/collapse handling.
- `Sidebar` — edge-kind filter toggles, full-text node search, a legend mapping color → kind.
- `NodeDetailPanel` — selected node's file path + line, and its incoming/outgoing edges grouped
  by kind; clicking an edge focuses the connected node.
- Custom node components — Chakra-styled, color-coded by kind, show kind icon + label.

## Code Layout

```
lib/
  graph/types.ts            # shared GraphModel types
  analyzer/
    index.ts                # composer: builds Project, runs sub-analyzers, merges
    imports.ts
    calls.ts
    inheritance.ts
    components.ts
    project.ts              # in-memory ts-morph Project factory
  layout.ts                 # dagre layout helper (GraphModel → positioned nodes)
  aggregate.ts              # symbol-level → file-level edge aggregation
app/
  page.tsx                  # upload + graph view
  api/analyze/route.ts      # thin: parse upload, run analyzer, return GraphModel
components/
  UploadDropzone.tsx
  GraphCanvas.tsx
  Sidebar.tsx
  NodeDetailPanel.tsx
  nodes/*.tsx               # custom React Flow node components
```

## Testing

- **TDD the analyzers.** Each sub-analyzer is tested with small fixture source strings fed
  through an in-memory ts-morph Project, asserting exact expected nodes and edges (including
  the type-resolution disambiguation case: two same-named functions resolve to distinct
  targets).
- **Aggregation** tested against a known symbol-level graph → expected file-level graph.
- **Layout** smoke-tested (every node gets a position; deterministic given input).
- **UI** verified by running the app (Bun + Next dev) against a sample repo and confirming the
  graph renders, filters work, and expand/collapse behaves.

## Error Handling

- Files that fail to parse are skipped and reported back in an `errors[]` field on the API
  response; the rest of the graph still renders.
- Empty / no-matching-files upload → friendly empty state, not a crash.
- Calls/usages resolving outside the uploaded set are silently dropped (not external edges).

## Out of Scope (YAGNI)

- Persisting graphs / accounts / sharing.
- Live filesystem watching or re-scan on change.
- Analyzing non-JS/TS languages.
- Editing code from the graph.
