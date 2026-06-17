# Smart Layout — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Per-cluster adaptive layout (grid / force / layered) + strongly-connected-component collapse so circular dependencies lay out as rings instead of breaking dagre.

**Architecture:** Add iterative Tarjan SCC (`lib/layout/scc.ts`). In `lib/layout/smart.ts`, replace `layoutCluster`'s single `dagreItems` call with: collapse multi-member SCCs into ring super-items → build the acyclic condensation → `chooseMode` picks grid/force/layered → expand rings. Pure TS; no renderer/worker changes.

**Spec:** [docs/superpowers/specs/2026-06-16-smart-layout-phase-b-design.md](../specs/2026-06-16-smart-layout-phase-b-design.md)

---

### Task 1: Tarjan SCC (`lib/layout/scc.ts` + test)

**Files:** Create `lib/layout/scc.ts`, `lib/layout/scc.test.ts`.

- [ ] Write `lib/layout/scc.test.ts`: `a→b→a` → one 2-member component; `a→b→c→a` → one 3-member; DAG `a→b→c` → three singletons; isolated nodes → singletons; deterministic component ids (`scc:` + sorted members) and deterministic ordering.
- [ ] Implement iterative Tarjan with sorted adjacency + sorted node order + sorted output; component `id = "scc:" + members.sort().join("|")`.
- [ ] `bun test lib/layout/scc.test.ts` passes.
- [ ] Commit.

### Task 2: Item-size-aware layout helpers + adaptive SCC step in `smart.ts`

**Files:** Modify `lib/layout/smart.ts`; add adaptive cases to `lib/layout/smart.test.ts`.

- [ ] Add `gridItems`, `circularItems`, `forceItems` (same `items: {id,width,height}[] → Map<id, center>` shape as `dagreItems`), adapted from `lib/layout.ts`'s `gridLayout`/`circularLayout`/`forceLayout` but item-size-aware. Add the d3-force imports.
- [ ] Add `chooseMode(n, m): "grid" | "force" | "layered"` (`m===0`→grid; `m > n*1.6`→force; else layered).
- [ ] Replace `layoutCluster` step 4 (the `dagreItems(items, sortedEdges, direction)` call) with: SCC collapse → ring super-items (via `circularItems` + bbox) → condensation items+edges → `chooseMode` → place → expand members back into a `centers` map keyed by **original** item ids. Steps 5–6 unchanged.
- [ ] Add adaptive tests to `smart.test.ts`: cyclic cluster (`x→y→z→x`) all contained + deterministic; edgeless cluster → no overlaps; dense cluster (≥ n*1.6 edges) contained + deterministic. Phase A invariants still pass.
- [ ] `bun test lib/layout/` passes.
- [ ] Commit.

### Final verification
- [ ] `bun run typecheck`, `bun run lint`, `bun run format:check`, full `bun test` — all clean.
- [ ] Commit any format fixes.

### Notes
- Commit as CapsaicinBunny; no `Co-Authored-By`. Run from `C:\Git\TSModuleScanner`.
- Determinism is required (layout cache keys on signature): sorted SCC output, sorted condensation edges, fixed force ticks, no `Math.random`.
