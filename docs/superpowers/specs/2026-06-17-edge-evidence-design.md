# Edge Evidence & Confidence — Design

**Goal:** Make PolyGraph a *trustworthy analyzer*: every edge records where the relationship occurs (file/line/column), which provider resolved it, and how confident that resolution is — and unresolved/ambiguous references become inspectable rather than silently dropped.

**Status:** Multi-phase. This document is the north-star + detailed **Phase 1**; Phases 2–4 are a roadmap, each getting its own plan as reached.

---

## Data model (the shared contract)

```ts
export type EdgeConfidence = "exact" | "inferred" | "ambiguous";

export interface EdgeEvidence {
  filePath: string;   // relative path of the occurrence
  line: number;       // 1-based
  column?: number;    // 1-based; omitted when a provider can't supply it
  provider: string;   // "TypeScript" (Phase 1); language name for native (Phase 3)
  confidence: EdgeConfidence;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  occurrences: EdgeEvidence[]; // capped at OCCURRENCE_CAP
  count: number;               // exact total occurrences (may exceed occurrences.length)
}

export const OCCURRENCE_CAP = 25;
```

`occurrences`/`count` are **required** on `GraphEdge` (breaking change). Edges from providers that don't yet emit evidence carry `occurrences: []`, `count: 0` — honest "not captured yet", never fabricated.

---

## Phases

- **Phase 1 — Evidence model + TS/JS capture + aggregation.** Types above; an `EdgeBuilder` that accumulates evidence with the cap + exact count; the six TS analyzers feed it; every edge-merge point (`buildView`, `dedupeEdges`, `collapse.ts`) merges occurrences instead of dropping. Pure TS, fully tested, no UI.
- **Phase 2 — Edge selection + evidence panel.** Renderer edge hit-testing → select an edge → `EdgeDetailPanel` (the mockup: "Calls X · N occurrences · file:line list · resolution · provider"). Occurrences thread through `ViewEdge` → `Scene` → payload.
- **Phase 3 — Native-core evidence (Rust).** `analyzer-core` emits line/column + provider (language) + confidence (`inferred`, or `ambiguous` when a name resolves to >1 target) for the tree-sitter languages; rebuild `.node`.
- **Phase 4 — Unresolved & ambiguous surfacing.** Providers emit references they couldn't resolve (or resolved ambiguously); a panel/list lets the user inspect them — the "what PolyGraph *couldn't* prove" view.

---

## Phase 1 — detailed design

### `lib/analyzer/edge-accumulator.ts` (new, pure, tested)

```ts
class EdgeBuilder {
  add(source: string, target: string, kind: EdgeKind, evidence: EdgeEvidence): void;
  build(): GraphEdge[];
}
```
- Keys by `(source,target,kind)` via `edgeId`. First `add` creates the edge; subsequent `add`s increment `count` and append to `occurrences` until `OCCURRENCE_CAP`, after which only `count` grows.
- Dedupes *identical* evidence (same `filePath:line:column`) so overlapping AST queries don't double-count one syntactic site.
- Drops self-edges (`source === target`).

### Capture in the six TS analyzers (`lib/analyzer/*`)

Each analyzer replaces its local `seen`-Set dedup with an `EdgeBuilder`. Evidence is taken from the AST node the edge is built from:
`filePath = toRelativePath(node.getSourceFile())`, and `{ line, column }` from `sourceFile.getLineAndColumnAtPos(node.getStart())`. `provider = "TypeScript"`.

Confidence:
| Analyzer | exact | ambiguous | inferred |
| --- | --- | --- | --- |
| `calls`, `composition`, `components`, `inheritance` | identifier resolves to exactly 1 **distinct** target id | resolves to >1 distinct target id | — |
| `imports` → in-project module | resolved to a project file | — | — |
| `imports`/`externals` → third-party | — | — | external boundary (import site exact, target is external) |

`calls.ts`'s `resolveTarget` is extended to report whether the identifier resolved to >1 **distinct** target id (→ `ambiguous`) — overloads / merged declarations that map to one node stay `exact`. References that resolve to **0** definitions are unresolved — still dropped in Phase 1 (surfaced in Phase 4).

### Edge-merge points (all must concat occurrences + sum counts, capped)

1. **`lib/analyzer/index.ts` `dedupeEdges`** — when two analyzers emit the same edge id, merge their occurrences (currently keeps the first, drops the rest).
2. **`lib/aggregate.ts` `buildView`** — `ViewEdge` gains `occurrences`/`count`; `push` merges on duplicate `(s,t,kind)` after symbol→file remap (currently drops).
3. **`lib/graph/collapse.ts`** — when rerouting absorbed edges to an aggregate, merge occurrences of edges that collapse onto the same endpoints (currently dedupes by id, keeping first).

A small shared helper `mergeEvidence(into: GraphEdge|ViewEdge, from)` (cap-aware) keeps these consistent.

### Native-core edges (Phase 1 placeholder)

The kernel maps `analyzer-core` edges → `GraphEdge` with `occurrences: []`, `count: 0`. (Phase 3 fills them.)

### Other construction sites

`edgeId` stays the id helper. Any remaining direct `{ id, source, target, kind }` literals (tests, `collapse.ts` aggregate edges) are updated to include `occurrences`/`count`. A tiny `makeEdge(source, target, kind, occurrences = [])` helper in `types.ts` reduces churn and sets `count = occurrences.length`.

### Testing

- **`edge-accumulator.test.ts`** — cap at 25 + exact count beyond it; identical-evidence dedup; self-edge drop; distinct kinds kept separate.
- **analyzer test** (extend `lib/analyzer` tests or kernel test) — a TS call site produces an edge whose `occurrences[0]` has the right `filePath`/`line`/`provider:"TypeScript"`/`confidence:"exact"`; two call sites → `count === 2`; a callee with 2 definitions → `confidence:"ambiguous"`.
- **`aggregate` test** — two edges collapsing onto one `(s,t,kind)` yield merged `occurrences` + summed `count`.
- **existing kernel/scene/collapse tests** — updated for the new `GraphEdge` shape; all stay green.

### Out of scope (Phase 1)

UI/edge-click (Phase 2), native evidence (Phase 3), unresolved/ambiguous surfacing (Phase 4), snippets.
