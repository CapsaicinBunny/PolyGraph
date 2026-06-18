# Edge Evidence — Phase 1 Plan

> Execute with superpowers:subagent-driven-development. One subagent per task, review each. Gate after each task: `bun run typecheck && bun run lint && bun run format:check && bun test`. Commit as CapsaicinBunny, no Co-Authored-By. Run from `C:\Git\TSModuleScanner`.

**Goal:** Capture per-edge evidence (file/line/column, provider, confidence) for TS/JS, with occurrences capped + an exact count, surviving all edge-merge points. No UI.

**Spec:** [docs/superpowers/specs/2026-06-17-edge-evidence-design.md](../specs/2026-06-17-edge-evidence-design.md)

---

### Task 1: Data model + helpers + keep the build green

**Files:** `lib/graph/types.ts`; new `lib/analyzer/edge-accumulator.ts` + test; update EVERY edge construction site + test to the new shape.

- In `types.ts`: add `EdgeConfidence`, `EdgeEvidence`, `OCCURRENCE_CAP = 25`; add **required** `occurrences: EdgeEvidence[]` and `count: number` to `GraphEdge`; add `makeEdge(source, target, kind, occurrences: EdgeEvidence[] = []): GraphEdge` (sets `id = edgeId(...)`, `count = occurrences.length`); add `mergeEvidence(into: { occurrences: EdgeEvidence[]; count: number }, from: { occurrences: EdgeEvidence[]; count: number }): void` (append up to `OCCURRENCE_CAP`, `into.count += from.count`).
- New `lib/analyzer/edge-accumulator.ts`: `class EdgeBuilder { add(source, target, kind, evidence: EdgeEvidence): void; build(): GraphEdge[] }` — keys by `edgeId`; dedups identical `filePath:line:column` evidence; caps `occurrences` at 25 while `count` keeps growing; drops `source === target`.
- **Make the whole project compile + tests pass with the new required fields:** update all `{ id, source, target, kind }` edge literals (in `lib/analyzer/*`, `lib/graph/collapse.ts`, the kernel native-edge mapping, and all test files) to include `occurrences`/`count` — use `makeEdge(...)` where convenient, or add `occurrences: [], count: 0`. Evidence stays EMPTY in this task (real capture is Task 2). Native-core edges get `occurrences: [], count: 0`.
- **Tests** (`edge-accumulator.test.ts`): 30 adds of the same edge → `occurrences.length === 25`, `count === 30`; identical evidence added twice → counted once; two different kinds between same nodes → two edges; self-edge dropped.
- Gate green.

### Task 2: TS/JS analyzers capture real evidence + confidence

**Files:** `lib/analyzer/{calls,imports,inheritance,composition,components,externals}.ts`; an analyzer/kernel test.

- Replace each analyzer's local `seen`-Set dedup with an `EdgeBuilder`. For each edge, build `EdgeEvidence`: `filePath = toRelativePath(node.getSourceFile())`, `{ line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart())`, `provider: "TypeScript"`, and `confidence` per the spec table:
  - `calls`/`composition`/`components`/`inheritance`: `exact` if the resolved identifier has exactly 1 definition node, `ambiguous` if >1. (Extend `resolveTarget` in `calls.ts` to report the definition count; mirror in the others.)
  - `imports`: `exact` when resolved to a project file; `inferred` for third-party.
  - `externals`: `inferred` (import site is exact, target is an external boundary).
- 0-definition references remain dropped (Phase 4 surfaces them).
- **Tests:** a TS project with a call site → the `call` edge's `occurrences[0]` has correct `filePath`/`line`/`provider:"TypeScript"`/`confidence:"exact"`; two call sites of the same callee → `count === 2`, one edge; a callee with two declarations (e.g. overloads/merged) → `confidence:"ambiguous"`.
- Gate green.

### Task 3: Merge occurrences at every aggregation point

**Files:** `lib/analyzer/index.ts` (`dedupeEdges`); `lib/aggregate.ts` (`ViewEdge` + `buildView`); `lib/graph/collapse.ts`; aggregate test.

- `dedupeEdges`: when an edge id repeats across analyzers, `mergeEvidence` into the kept edge instead of dropping.
- `aggregate.ts`: add `occurrences: EdgeEvidence[]` + `count: number` to `ViewEdge`; `push` carries them, and on duplicate `(s,t,kind)` after remap it `mergeEvidence`s into the existing `ViewEdge` (track the edges by id in a Map to merge). Containment edges get `occurrences: [], count: 0`.
- `collapse.ts`: when rerouting absorbed edges to aggregates, merge occurrences of edges that land on the same `(source,target,kind)` (currently dedupes by id, keeping first).
- **Tests:** `aggregate` — two symbol→symbol edges that collapse to the same file→file `(s,t,kind)` produce one `ViewEdge` with concatenated `occurrences` + summed `count`.
- Gate green.

---

## Final
- [ ] Full gate green; existing suite + new tests pass.
- [ ] Confirm a real scan still works (controller spot-check).
- [ ] finishing-a-development-branch → PR → merge. Phases 2–4 follow.
