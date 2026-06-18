# Advanced graph search + package/architecture levels

**Status:** approved (architecture), implementing
**Date:** 2026-06-17

Two coordinated features over the same base symbol graph:

- **#9 Advanced graph search** — a small query language for the search box.
- **#10 Abstraction levels** — Workspace › Package › Directory › File › Symbol, with
  manifest-aware package detection.

They meet at the scene pipeline ([lib/graph/scene.ts](../../../lib/graph/scene.ts)). The
query engine evaluates against whatever level is active, so one grammar works at every
altitude.

```
   base graph ──▶ LEVEL PROJECTION (#10) ──▶ leveled graph
 (symbol-level)   symbol→file→dir→pkg→ws            │
                                                    ▼
                            SceneFilters (existing checkboxes) ──▶ intersect
                                                    │
   query text ──▶ QUERY ENGINE (#9): parse→compile→evaluate ──▶ {nodeIds, edgeIds}
                                                    │
                                        mode: filter | highlight
```

## Design commitments

1. The query engine is a **separate evaluator**, not a rewrite of the filter checkboxes.
   Query results **intersect** with the existing filter panel; both narrow the view.
2. The query engine evaluates **against the active level**. `depends-on:"database"` at
   Package level answers "which packages depend on the database package".
3. **Manifest parsing lives in the TS server layer** ([lib/server/](../../../lib/server)),
   not the Rust core — no `.node` rebuilds, pluggable per ecosystem.

---

## Feature #9 — Query language

### Grammar (v1)

A query is whitespace-separated **terms** combined with implicit **AND**. Supported:

- `field:value` — field predicate.
- `field:OP n` — numeric comparison, `OP ∈ > < >= <= =`, e.g. `calls:>10`.
- `"quoted text"` or bare `word` — case-insensitive substring match on `label`
  (back-compatible with today's search).
- `-term` / `not term` — negation.
- `a | b` / `a or b`, grouping with `( … )` — disjunction.
- `LHS -> RHS` — **path/flow** term: edges whose source matches `LHS` and target matches
  `RHS` (e.g. `environment:client -> environment:server`).

### Fields

| Field | Aliases | Matches |
|-------|---------|---------|
| `kind:` | | NodeKind (`function`, `trait`, `class`, `external`, …) |
| `language:` | `lang:` | language key/label (`rust`, `ts`), case-insensitive |
| `path:` | | glob on `filePath` (`*`, `**`) |
| `environment:` | `env:` | `client` \| `server` |
| `runtime:` | | `node` \| `deno` \| `bun` |
| `category:` | | `ui` \| `feature` |
| `role:` | | NodeRole (`react-component`, `ecs-system`, …) |
| `package:` | `pkg:` | package name (level feature) |
| `dependency-type:` | `dep:` | `dependency` \| `devDependency` \| … |
| `calls:` | | outgoing **call**-edge count (numeric) |
| `incoming:` | | in-degree, all edges (numeric) |
| `outgoing:` | | out-degree, all edges (numeric) |
| `depends-on:` | | transitively depends on a node matching the value |
| `cycle:` | | `true`/`false` — participates in a cycle (SCC size > 1) |

### Evaluation

- `tokenize → parse (AST) → compile (predicate) → evaluate`.
- A precomputed `MetricsIndex` carries adjacency, in/out degree, call-out-degree, SCC
  membership, and a memoized reachability helper for `depends-on`.
- Result `QueryResult = { nodeIds: Set<string>; edgeIds: Set<string>; error?: string }`.
  - Node-predicate query → `nodeIds` = matches, `edgeIds` = induced edges between them.
  - Path query `A -> B` → `edgeIds` = matching edges, `nodeIds` = their endpoints.
- Invalid syntax sets `error` and matches nothing (the bar shows the message); it never
  throws into the render path.

### Modes

A toggle on the query bar:

- **filter** — `visible` is further restricted to `nodeIds` (∩ existing filters).
- **highlight** — full graph stays, matches are emphasised and framed (reuses the
  existing search-to-focus camera).

### Saved searches

- **Built-in presets** (shipped in code, tunable): Public API, High-impact modules,
  React rendering tree, Database access, Circular dependencies — each a label + query
  string.
- **User saved searches** — persisted to `localStorage` (web) / settings (Tauri), a list
  of `{ name, query }`.

---

## Feature #10 — Abstraction levels

### Levels

`workspace | package | directory | file | symbol`. Directory/File/Symbol already exist
via collapse/aggregate; this adds **package** and **workspace** as first-class levels and
a level switcher (segmented control). Selecting a level sets aggregation granularity; the
base symbol graph is projected up to that altitude reusing the existing collapse machinery.

### Manifest providers

A pluggable `ManifestProvider` registry mirroring `language-packs`. Each provider detects
its manifests under the scan root and yields `PackageManifest` records:

```ts
interface PackageManifest {
  id: string;          // stable: ecosystem + name (+ dir)
  name: string;
  ecosystem: string;   // "npm" | "cargo" | "go" | "python" | "maven" | "gradle" | …
  dir: string;         // relative dir that owns this package
  manifestPath: string;
  workspace?: string;  // owning workspace id, if any
  declaredDeps: { name: string; version?: string; type?: DependencyType }[];
}
```

v1 ships: **npm/workspaces** (`package.json` + pnpm/yarn/npm workspaces), **Cargo**
(`Cargo.toml` + `[workspace]`), **Go** (`go.mod`/`go.work`), **Python** (`pyproject.toml`,
fallback `setup.py` name only), **Maven** (`pom.xml`), **Gradle** (best-effort name from
`settings.gradle[.kts]`; documented as lower-confidence). The registry is extensible to
every supported language.

### Package projection

- Build a path → package map (nearest enclosing `dir`).
- Assign each base node to a package; nodes outside any manifest fall into a synthetic
  `«root»` package.
- Package-level edges = aggregation of base edges crossing package boundaries (evidence
  merged, like the directory aggregate), **unioned** with declared manifest deps.
- Workspace level groups packages by `workspace`.
- "Which packages depend on this package" reuses `dependents()` on the package-projected
  graph.

---

## Testing

Pure cores get unit tests (`bun:test`) following existing patterns:

- `lib/graph/query-language/*.test.ts` — tokenizer, parser, evaluator (every field +
  path + boolean ops + numeric ops + error cases).
- `lib/graph/levels/*.test.ts` — package projection, workspace grouping, package deps.
- `lib/server/manifests/*.test.ts` — each manifest provider parses fixtures correctly.
- Scene integration test: query result narrows `visible`; level switch reshapes the graph.

UI (query bar + mode toggle + saved searches dropdown; level switcher) wired into
[components/Explorer.tsx](../../../components/Explorer.tsx) /
[components/Sidebar.tsx](../../../components/Sidebar.tsx) after the cores are green.

## Out of scope (v1)

- Two-way binding between the query bar and individual filter checkboxes.
- Lockfile-precise version resolution; Gradle dependency graphs (names only).
- Cross-language package import resolution.
