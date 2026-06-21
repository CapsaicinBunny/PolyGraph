# Representation-LOD Unification — Design Spec (Rev 3)

> Status: **FROZEN — approved 9.6/10 (review #3)** · 2026-06-21 · branch `feat/dimension-spine` (PR #77)
> Rev 3 adds the **Nanite-scale proxy tier**, **cut-aware edge-cost**, and **commit-policy**
> requirements from implementation review #2. The direction is **approved** (review rated it
> **9/10**); the three "must-add-before-freeze" requirements below are **required before freezing**
> the spec. Rev 2's verified-good structure (Goal, Architecture, gaps 1–8, finite budget, integration
> contracts, edge cases, P0–P5, merge gate) is retained; Rev 3 extends it.
> Review #3 gave **final approval (9.6/10): freeze and begin implementation** and added
> implementation notes only (CSR edge index, connected-transition commit batches, intermediate-tier
> limits, split coarsening/refinement readiness) — **no architecture change**.

## Goal

Make the **representation cut** the one and only LOD — covering every base the old
camera/directory-collapse (`adaptiveLod` + C1a `computeCut`/`computeGroupCut`) covered, fixing
its gaps (ungrouped None unbounded; layout re-runs globally each recut; not actually
layout-independent), and **retiring** C1a. The old retires; the new replaces; no backwards-compat
compromises — but **only after** the gates prove the replacement is real in every mode.

### Non-goals
Problems-panel rewrite (separate; only don't break it), new grouping/filter semantics, the scan
pipeline.

---

## Must-add-before-freeze (review #2) — the three blockers

These three are the load-bearing additions. Direction is approved; the spec does **not** freeze, and
P0.5/P1 do not start claiming completeness, until all three are designed in and reflected below.

### B1. Intermediate render-only proxy tiers — the biggest gap

The representation builder (`lib/graph/representation.ts:57`) parents each node leaf rep **DIRECTLY**
under its semantic group rep — group reps occupy `[0, groupCount)`, leaf reps occupy
`[groupCount, repCount)`, and every leaf's `parentByRep` is set to its direct group ordinal
(`representation.ts:195–208`). There is **no intermediate tier** between a semantic group and its
node leaves. Consequence for the flat modes (Package / Community / facet, and any grouping that is one
semantic level deep): opening one group is an **atomic** replacement of one proxy with **all** of its
leaves — up to ~20k cards in one transition. The solver's hard budget (`refineAtomic` →
`withinCeiling`, solver `:346–408`) correctly **rejects** that single refine, so the group is **stuck
at one aggregate card forever** — it can never progressively refine. This breaks the central promise
that "every group can progressively refine."

**Fix — Nanite-style render-only intermediate proxies.** Insert a bounded tree of
**render-only intermediate proxy reps** between a semantic group rep and its leaves. They carry no
new semantic meaning (they are not groups in the snapshot); they exist purely so refinement has
intermediate antichains to land on. Source of the subdivision, in priority order:

1. **Recursive community partitioning** of the group's induced subgraph (reuse the existing community
   detector on the in-group edges).
2. **Graph coarsening** (matching / heavy-edge contraction) where community partitioning is
   degenerate.
3. **Directory subdivisions** where a path prefix is available for the group's members.
4. **Deterministic balanced chunks** (stable fan-out-bounded buckets over the canonical node order) as
   the always-available fallback.

**Invariants (must hold for every grouping mode):**

- **(a) Coarsest cut fits the hard budget.** The top antichain of every group's proxy subtree, taken
  together across all groups, is within `hardCards`/`hardLayoutCost`.
- **(b) No representation has unbounded fan-out.** Every rep's child count ≤ a fixed `MAX_FANOUT`;
  oversized membership produces additional intermediate tiers rather than a wide level.
- **(c) An oversized semantic group receives intermediate proxies** — subdivision is triggered by
  subtree size, not by mode.
- **(d) A one-level refinement never requires revealing the entire semantic group** — refining a
  group proxy yields its intermediate children (bounded), not its leaf set.

**Bootstrap feasibility (NO_GROUP orphans).** Orphan leaves (NO_GROUP / excluded grouping / malformed
metadata) currently become **independent ROOTS** (`representation.ts:9–10`, set at `:200–201`, pushed
at `:223`), and `rootCut` selects **every** root (`lod-cut-solver.ts:86–88`). A graph with many
orphans therefore starts the bootstrap antichain **already over budget**, before any refinement can
run — and refinement only ever *adds* cards, so the cut can never become feasible. **Fix:** introduce
a **synthetic super-root** (or a bounded set of **deterministic root-bucket proxies**) that adopts the
orphan leaves and the semantic-group roots, so the bootstrap antichain is **always budget-feasible**.
Root buckets obey the same fan-out bound (b) and may themselves be tiered.

### B2. Persistent, cut-aware hierarchical edge index

Edge cost is **cut-DEPENDENT, not additive.** The number of visible aggregated edges depends on
**which** proxies are co-selected (two children of the same parent may share one aggregated edge at
the parent level but two distinct edges once both are open; an edge between two folded subtrees
collapses to a single boundary edge). The builder today defaults the node-attributed `edgeCost` to
**0** (`representation.ts:156`: `edgeCostOf = costs.edgeCost ?? (() => 0)`), and the solver sums
per-rep `edgeCost` additively (`sumCost`, solver `:117–131`). With both, the edge budget is
effectively inert and the solver can approve a node-cheap refinement that **explodes the visible edge
count**.

**Fix — a persistent `RepresentationEdgeIndex`** built alongside the hierarchy and cached on the same
material signature:

- **Boundary summaries between rep subtrees:** `outgoingByRep` / `incomingByRep` as `Uint32Array[]`
  (per rep, the aggregated cross-boundary edge endpoints toward other reps).
- **Original `edgeRanges` grouped by the lowest relevant rep pair** — so the real edges underlying any
  proxy↔proxy boundary can be retrieved without scanning all edges.

**Marginal edge delta (the solver's new edge gate).** For a proposed `parent → children` refinement,
compute the **actual marginal edge delta in the active quotient graph**:
`Δedges = edgesAfterReplacingParentWithChildren − edgesBefore`, evaluated against the **currently
co-selected** reps (not a static per-rep number). `refineAtomic` consults this Δ so the solver
**never approves a node-cheap refinement that blows past `hardEdges`.** The quotient-graph evaluation
uses the boundary summaries, so it is local to the refined region.

### B3. Single atomic cut/layout readiness policy

Rev 2's "commit the scene atomically **or** support progressive proxy→detail replacement" is
ambiguous. Rev 3 pins **exactly one** policy:

1. The solver produces a **PENDING target cut** (a valid antichain) — not yet committed.
2. **Cached** local layouts for the affected subtrees **resolve immediately**.
3. **Missing** local layouts run **async** (worker), tagged with the target generation.
4. The **current committed cut stays visible** meanwhile — no blank frame, no partial scene.
5. When **all data for ONE subtree transition** is ready, **that subtree commits atomically** — its
   reps swap in a single scene mutation.
6. **Stale generations are discarded** — a layout result whose generation ≠ the live target is
   dropped.

Each **independent subtree transition commits atomically** → the rendered scene is a **sequence of
always-valid antichains**, and there is **no global wait** on the slowest subtree. (This subsumes
Rev 2's CutDiff orchestration: the diff drives which subtrees are in flight; the readiness policy
governs when each commits.)

---

## Cutover condition (the essential freeze gate)

> Delete C1a only when every grouping mode — including None — can progressively refine through bounded
> proxy tiers, without rescanning the complete graph, exceeding finite hard budgets, or triggering a
> global layout.

Target system boundaries:

```
post-filter graph → persistent semantic grouping → bounded render-proxy hierarchy
→ cut-aware edge index → constrained antichain solver → pending target cut
→ incremental proxy materialization → generation-safe local layouts
→ atomic transition batches → committed scene
```

## Implementation notes (review #3)

These four notes are **implementation guidance** that **refine B1/B2/B3 — they do not replace them.**
The architecture is unchanged; these pin the concrete data layout and commit rules so implementation
does not regress the budget/antichain guarantees at kernel scale.

### (a) Edge index as CSR, not `Uint32Array[]` (refines B2)

At kernel scale, one array-of-typed-arrays per rep is **millions of small objects** — fragmented heap,
poor cache locality, expensive to transfer to the worker. Use a compact **columnar (CSR) layout**:

```ts
interface RepresentationEdgeIndex {
  outgoingOffsets: Uint32Array; outgoingTargets: Uint32Array;
  outgoingKinds: Uint16Array;   outgoingCounts: Uint32Array;
  incomingOffsets: Uint32Array; incomingSources: Uint32Array;
  rangeOffsets: Uint32Array;    originalEdgeOrdinals: Uint32Array;
}
```

Better transfer/cache locality; **supersedes the `Uint32Array[]` sketch in B2** (boundary summaries +
`edgeRanges` by lowest rep pair are now expressed in these flat columns).

### (b) Connected-transition commit batches (refines B3)

Two changed subtrees may have **edges between them**: committing one before the other changes the
quotient graph the edge costs were computed against. Add:

```ts
interface TransitionBatch { roots: Uint32Array; targetGeneration: number; }
```

Rules:

- Changed subtrees with **no boundary relationship** commit **independently**.
- Subtrees connected by **affected quotient edges** commit as **ONE batch** (or recompute the edge
  delta against the **currently-committed** cut).
- **Every batch revalidates hard budgets immediately before commit.**
- A **rejected batch leaves BOTH the scene and the committed cut unchanged.**

This refines B3's per-subtree commit policy: the unit of atomic commit is the connected batch, not an
isolated subtree, whenever a boundary relationship exists.

### (c) Explicit intermediate-tier limits (refines B1)

Named constants + a **deterministic fallback** for proxy-tier construction:

```ts
const MAX_FANOUT = 32;
const MAX_LEAVES_PER_PROXY = 128;
const MAX_PARTITION_DEPTH = 12;
const MAX_PARTITION_WORK_MS = 50;
```

Strategy sequence: **community partition → validate balance & fan-out → heavy-edge coarsening →
directory subdivision → deterministic balanced chunks.** If community detection yields **one huge +
several tiny** partitions, **REJECT it** and continue to the next strategy. Include the partition
algorithm + thresholds in `representationBuilderVersion` so proxy caches invalidate correctly.

### (d) Separate coarsening vs refinement readiness (refines B3)

Coarsening usually needs **no async layout**, so it should not wait. Rules:

- **Coarsening** commits **immediately** after proxy + edge materialization.
- **Refinement with a cache HIT** commits **immediately**.
- **Refinement with a cache MISS** **retains the existing proxy** until the local layout returns.
- A **mixed connected batch** waits until **all required refinements in that batch** are ready.

This refines B3 by preventing unnecessary waiting on zoom-out / eviction (pure coarsening), while still
honoring the connected-batch rule (b) for mixed transitions.

---

## Architecture (target)

One budgeted **valid-antichain cut** over a **persistent, post-filter representation hierarchy** (now
with **render-only intermediate tiers** and a **synthetic super-root**) selects which proxies are
committed (rendered + locally laid out) vs folded. Target flow:

```
persistent RepresentationRuntime (cached by material signature, post-filter)
  ├─ RepresentationHierarchy  (semantic groups + render-only intermediate proxies + super-root)
  └─ RepresentationEdgeIndex  (boundary summaries + edgeRanges by lowest rep pair)
  → solveLodCut (finite budgets, marginal node+EDGE cost priority, deterministic arbitration)
  → PENDING target cut (valid antichain)
  → GENERIC proxy materialization (incremental, CutDiff-driven; edge cost via the edge index)
  → per-subtree atomic commit when its local layout is ready (B3)
  → scene  (sequence of always-valid antichains)
```

The cut is computed from structure + snapshot + **stable proxy geometry independent of the visual
layout engine** + camera + budget — never from the engine name *or* from live cluster boxes that
only some engines produce. That is what makes it genuinely layout-independent.

What stays (**temporarily** — see §"Retire compose()"): `compose()` for C1a-compat, workspace
migration, legacy UI state, and translating intent/bootstrap into solver constraints. What must be
**replaced, not reused as-is**: `collapseClusters()` (directory/community-only; see Gap 1).

## Reality check — what the current rep-cut impl gets wrong (verified)

These are confirmed in code and must be fixed; several **block C1a deletion**.

1. **`collapseClusters()` is not generic (correctness, blocker).** `lib/graph/collapse.ts:58–68`
   absorbs nodes only by **directory prefix** or `communityOf` — there is no membership path for
   **package / facet / synthetic-None / arbitrary representation proxies**, and community is only
   passed when the (now-removed) `communityCollapse` toggle was on. So the "mode-agnostic" cut can
   update LOD state for Package/facet without actually folding those nodes into cards. **Replace
   with generic proxy materialization:** `LodCut → active-representative-per-node → proxy nodes +
   aggregated edges → scene` (a proxy scene materializer), removing the pretence that every proxy
   is a collapsed directory. **Do not delete C1a until this is live.**
2. **None is already modeled — geometry/rendering is the gap.** `syntheticNoneGrouping()`
   (`lib/graph/grouping.ts:331`, connected-components→communities, every node gets a path) already
   exists. The blockers: Explorer returns no cut snapshot for None; the canvas early-returns when
   `boxes.size === 0`; `canRefine()` needs a live box matching the group's `boxKey`; None draws no
   group boxes. So the None task is: feed the **existing** synthetic hierarchy into the rep
   builder; generate **invisible but stable proxy bounds**; materialize proxy cards **without**
   drawing container boxes; drop the `boxes.size === 0` early-return only after those bounds exist.
   **Keep components→communities** unless a bench proves directory→kind better (the latter makes
   None filesystem-driven and risks huge disconnected kind buckets).
3. **Not actually layout-independent.** The cut derives geometry from live `scene.clusters` /
   aggregate cards; when the engine emits no cluster boxes (Grid, classic engines, None) the canvas
   exits before computing the cut. Need an explicit **proxy layout → stable representation boxes**
   source, with the **selected visual layout placing node geometry inside** those boxes. "Layout-
   independent" must mean *operates with every engine*, not merely *doesn't read the engine name*.
4. **Hierarchy rebuilt on every recut (scalability).** `buildSceneRepresentationCut()` rebuilds the
   whole hierarchy (arrays, subtree-cost rollups, DFS intervals, group-id map) + the canvas
   rebuilds the node-id array, **every commit** — O(N) over millions of nodes. Local-layout caching
   does not fix this. **Cache a persistent `RepresentationRuntime`** (hierarchy, edge index, nodeIds,
   `repOfGroupId`, eviction, lodRuntime) keyed by a **material signature** (filtered-graph identity,
   grouping mode/version, node-cost inputs, builder version). Camera movement updates bounds /
   priorities / cut — never reconstructs. **Prerequisite before local-layout wiring.**
5. **Solver uses the wrong marginal cost.** `refinePriority()` (`lib/graph/lod-cut-solver.ts:417`)
   ranks by the parent's *own* cost, not the child-expansion delta (`Σ child − parent`), so a
   2-child and a 2000-child proxy look similarly cheap. And `refineUnderBudget()` **breaks** the
   loop when the top candidate doesn't fit (`:321,:324`), leaving budget unused. **Fix:** rank by
   real marginal delta normalized by remaining budget; on non-fit `blocked.add(best); continue;`
   instead of stopping. (Fix before any parity claim vs C1a.)
6. **Hard budget ≈ the whole graph.** `lib/graph/lod-representation-cut.ts:186–190` sets
   `hardNodes = max(nodeBudget, totalNodes)`, `maxLayoutWork = max(nodeBudget, totalNodes)`,
   `hardEdges/hardLabels/maxGpuBytes = Infinity`. Forced opens can expand to the full graph (≈1M on
   Linux). **Define one finite production budget model** (see below) — not merely consolidate
   constants.
7. **Cut is not clearly post-filter.** Snapshots + `nodeIds` are built from the full `graph.nodes`;
   filtering happens later in `buildSceneStructure`. Hidden nodes then contribute to proxy subtree
   cost / card-budget pressure, and proxies can exist only because of filtered-out nodes. Build the
   cached runtime from a **post-filter projection / visible-node ordinal mask**.
8. **Eviction LRU ignores panning.** `recomputeCut()` is scheduled from the **wheel** handler only;
   pan (pointer-move / pointer-up) schedules nothing, and the camera-band guard rejects recompute
   unless the zoom band increases. Panning an open region off-screen never updates retention /
   eviction. **Add a debounced pan-end visibility recut** (updates visibility + LRU **without**
   forcing deeper refinement). Unify the camera policy: *zoom → band/deadband refine*; *pan →
   visibility/LRU only*.

## Finite budget model (replaces Gap 6) — split budget units

`nodeCost = 1 + symbols` is **layout cost, NOT visible-card count** — a refined proxy's "node" budget
charges layout work, so `targetNodes/hardNodes` conflate two distinct pressures and are **misleading**.
Rev 3 splits the budget so a proxy can be **one card** while carrying **high future layout cost**
(distinct signals the solver weighs independently):

```ts
const LOD_BUDGET = {
  // visible cards (one proxy = one card; the antichain width the user sees)
  targetCards: 800,        hardCards: 2_000,
  // layout cost (Σ (1 + symbols) over refined reps — the relayout work pressure)
  targetLayoutCost: 2_500, hardLayoutCost: 6_000,
  // aggregated edges in the active quotient graph (cut-dependent; via the edge index — B2)
  targetEdges: 8_000,      hardEdges: 25_000,
  // labels drawn
  targetLabels: 500,       hardLabels: 2_000,
  // GPU geometry budget
  maxGpuBytes: 128 * 1024 * 1024,
};
```

Soft targets steer; finite hard ceilings cap forced opens; when intent can't be honored within the
hard ceiling, surface **"Detail limited"** rather than silently expanding. The solver's
`CostVec`/`withinCeiling` (solver `:71–77`, `:392–408`) must be widened from the conflated `nodes`
dimension to `cards` + `layout`, and `edges` must read the **marginal quotient-graph delta** (B2), not
the additive per-rep sum. Exact numbers are pinned by the P4 bench, but every ceiling is finite —
`Infinity`/`totalNodes` are not limits.

## Local-layout orchestration (P3 — more than `refineGroup()`)

A committed cut may open AND close several proxies. Integration needs a **cut diff** (now consumed
**incrementally** — see Gap 9 / P1):

```ts
interface CutDiff { refined: Uint32Array; coarsened: Uint32Array; unchanged: Uint32Array; }
```

Then: compute local-layout cache keys → reuse hits → start cache-miss **worker** jobs → apply the
**single atomic readiness policy (B3)**: cached subtrees commit immediately, uncached run async, the
prior cut stays visible, each subtree commits atomically when ready, stale generations are dropped.
Preserve all unaffected group origins (byte-identical). Plus: cache memory limit / LRU, cancellation
of obsolete requests, **generation tokens** in worker responses. The overflow ladder stays scoped
(`global:false`); a cut change **never** launches a full-repository layout.

**Perf objective** (not "every recut within a frame"):
`cut solve < 8–16 ms` · `cut diff + scene stitch < 16 ms` · `cached refinement < 16 ms` ·
`uncached layout = async, cancellable, proxy stays visible meanwhile`.

## Incremental generic materialization (new — Gap 9)

The generic proxy materializer (P1) must be **incremental**, consuming the `CutDiff` and updating
**ONLY** the changed region:

- **Nodes** in changed subtrees (`refined` ∪ `coarsened`) — never the full node set.
- **Boundary edges incident to changed subtrees** — retrieved from the edge index (B2), not by
  scanning all edges.
- **Internal density stats** for the affected proxies (the per-proxy edge statistics feeding error
  scoring).
- **Affected proxy evidence handles** only.

`unchanged` subtrees are **not touched** — their materialized cards, aggregated edges, and origins are
reused byte-identical. Using the edge index, recut cost is **proportional to the changed region, NOT
O(all ~1.3M edges) per recut**. This is the materialization counterpart of the persistent-runtime fix
(Gap 4): Gap 4 stops rebuilding the hierarchy; Gap 9 stops rebuilding the scene.

## Retire `compose()` from the authoritative path (new — after P1)

Once the rep cut is the sole authority, the production render path is:

```
intent → solver constraints → LodCut → proxy materializer → scene
```

**NOT** `LodCut → derive open groups → compose() another collapsed state → mutate the solved
representation`. Re-deriving open groups and re-composing a collapsed state **after** the solver
applies collapse semantics on top of the solved cut, which can **invalidate the solver's antichain /
budget accounting** (the very guarantees `solveLodCut` establishes). `compose()` may remain
**TEMPORARILY only** for: C1a compatibility, workspace migration, legacy UI state, and translating
intent/bootstrap into solver constraints — **never modifying the production scene** once the rep cut
is sole authority.

## Focus mode is NOT a literal cut bypass (revised contract)

Rev 2 said "focus mode bypasses the cut." That is wrong: a focused node rendered outside the cut is
**double-represented** — it appears both as itself and inside its selected ancestor proxy — which
breaks the antichain (every node represented exactly once) and the budgets. **Model focus as a
high-priority `forceOpen`:** the solver descends toward the focused node honoring the **hard** budgets;
if descent is impossible within hard, **retain the nearest proxy and highlight it** (exactly the
existing hidden-node→proxy behavior via `activeProxyBoxKeyOfNode`). A **temporary detail overlay
OUTSIDE the graph scene** (a side panel / popover) is permitted; an **extra in-graph representation is
not.** Problems panel still sets `focusedIds`; those become high-priority forceOpen constraints (see
arbitration below).

## Deterministic forced-open arbitration (new — Gap 7 detail)

The solver iterates `forceOpen` over a **Set** (`lib/graph/lod-cut-solver.ts:192`) — order is
insertion-dependent and therefore **non-deterministic when the opens jointly exceed the hard budget**
(whichever is visited first wins the budget; later ones hit "Detail limited"). Pin a **total priority
order** for arbitration:

1. the **currently-clicked** open request,
2. the **selected/highlighted path** (incl. Problems-panel `focusedIds`),
3. **most-recently-interacted**,
4. **viewport-center** proximity,
5. **stable rep id** (final tiebreak — fully deterministic).

When an open cannot be honored, return structured detail rather than a silent retain:

```ts
interface LimitedDetail {
  requestedRep: number;
  resolvedRep: number; // the nearest proxy actually retained
  limitingBudget: "cards" | "edges" | "labels" | "gpu" | "layout";
}
```

The UI surfaces an honest **"Detail limited"** message naming `limitingBudget`. (`forceOpenRep`,
solver `:231–256`, already retains the nearest legal proxy on a hard-budget breach — it must now emit
`LimitedDetail` and be driven in the arbitration order, not Set order.)

## Integration contracts (must honor)

Filters: cut on the **post-filter** scene; **reuse filtered community detection** (re-running
relabels communities → breaks Community LOD). Animation/tracing: already robust (paths on code
edges, `pruneAnchors` on fold); keep the **hidden-node→proxy** map (`activeProxyBoxKeyOfNode`).
Layout: **box per committed group** or Smart→Grid; seed from prior layout. Camera/fit: excludes
the cut (recuts never re-frame). Focus mode: **high-priority forceOpen, not a literal bypass** (see
above). Problems panel: **no change to its API** (sets `focusedIds`; those map to forceOpen
constraints — focus no longer "bypasses").

## Edge cases (preserved)

Huge-repo scan seeding, Reveal-detail, `nodeCost = 1 + symbols` (now charged to `layoutCost`, not
`cards`), camera-band recut/debounce/monotonic zoom-in, offscreen eviction, Grid/Backbone fallback
(keep guard), 8 s worker timeout, per-mode state isolation, stale-group-id resilience.

## Revised implementation order (P0 → P5)

- **P0 — Correctness + persistent runtime** *(before None or local layouts).* Cache
  `RepresentationRuntime` by material signature; cache node ordinals + group-id maps; make the
  hierarchy **post-filter**; fix the solver's marginal **delta-cost** + **continue-after-oversized**;
  define **finite hard budgets**; add **pan-end visibility recuts**.
- **P0.5 — Representation normalization** *(new — must happen before claiming every group can
  progressively refine).* Synthetic **super-root / root-bucket proxies** (B1 bootstrap); **bounded
  fan-out** on every rep (invariant b); **intermediate render-only proxies** between semantic groups
  and leaves (B1, sources 1–4); the **budget-feasible bootstrap invariant** (a); **deterministic
  constraint arbitration** (Gap 7 / B-arb). Without P0.5, the flat modes are stuck at one aggregate
  card and a high-orphan graph starts over budget.
- **P1 — Generic proxy materialization (incremental + edge-aware).** Replace directory/community
  absorption with active-representative-per-node → proxy nodes + aggregated edges → scene. **Adds:**
  the persistent **hierarchical edge index** (B2); **cut-diff-based node + edge updates** (Gap 9);
  **internal proxy edge statistics**; and **removing `compose()` from the authoritative render path**.
  *This is what makes Package, facet, Community, and None genuinely work.*
- **P2 — Synthetic None + layout-independent proxy bounds.** Wire the existing
  components→communities hierarchy; invisible container geometry; stable proxy bounds independent of
  the visual engine; remove the `boxes.size === 0` escape; bench vs directory→kind before changing.
- **P3 — Local-layout orchestration.** Cached per-group layouts; cut diffing; **single atomic
  per-subtree commit policy (B3)**; async generation cancellation; overflow ladder (scoped only);
  cache eviction.
- **P4 — Budget consolidation + parity / stress bench.** Old vs new on: visible info at equal card
  budget; edge count/aggregation; cut-solve / scene-build / layout time; # camera-induced global
  moves; intent correctness; **all grouping modes**; **filtered graphs**; **panning as well as
  zooming**. **New stress metrics:** original **nodes scanned per recut**; original **edges scanned
  per recut**; **max representation fan-out**; **bootstrap-cut cost vs hard budget**; **rejected
  explicit opens by budget category**; **time from camera move to committed refinement**; **stale
  local-layout jobs discarded**; **peak local-layout cache memory**.
- **P5 — Delete C1a.** Remove `lod-cut.ts`, `group-cut.ts`, `lod-selection.ts`, the C1a telemetry +
  canvas branches, the duplicated budget constants, and the `representationLod` prop entirely.

P1 plus P2 test scaffolding can parallelize; P0.5 precedes P1; P3 depends on P0–P2; P4 then P5 are
sequential.

## Merge gate (do not delete C1a / merge until ALL hold)

1. Representation hierarchy **persistent** across camera recuts. 2. Proxy materialization works for
**Directory, Community, Package, facet, None**. 3. None + non-Smart layouts have usable proxy
bounds. 4. Cut costs use the **post-filter** graph. 5. Solver uses **actual marginal** refinement
cost. 6. A too-large candidate **does not block** smaller ones. 7. **Finite** hard budgets. 8.
**Pan-end** updates retention/eviction. 9. Local-layout cache misses are **async + generation-safe**.
10. A cut change **never** launches a full repository layout. 11. **Parity benchmarks pass** on real
repos. 12. **Real CI runs green** — the PR currently shows a completed workflow with **no jobs** (test
totals live only in commit/PR text); a 75-commit architectural PR needs an actual CI job (GitHub
Actions running `bun test` + **typecheck** + **lint** + **format**) before merge.
13. **Intermediate render-only proxies exist for every mode, and the bootstrap (root) cut is
budget-feasible** (B1: super-root/root buckets + bounded fan-out + intermediate tiers; invariants a–d).
14. **A cut-aware edge index drives marginal edge cost** — the solver evaluates the quotient-graph
edge delta, never the additive per-rep `edgeCost` default of 0 (B2).
15. **A single-group refinement does not rescan all original nodes or edges** — incremental
materialization touches only the changed region (Gap 9).
16. **The single atomic-per-subtree commit policy is implemented** — PENDING target cut, cached
commits immediate, uncached async, prior cut visible, per-subtree atomic commit, stale generations
discarded (B3).

**PR description must be updated to match.** It currently says local-layout wiring is *deferred* and
the feature is *"fully functional"* — contradictory given gates 9/13/16. Update it to reflect the
P0.5 + edge-index + commit-policy work as in-scope-before-merge, and retain the **real-CI**
requirement (test / typecheck / lint / format jobs actually executing).

## Delivery strategy

PR #77 is **already very large**. Deliver **P0 / P0.5 / P1 / P2 / P3** as **stacked commits or child
PRs**, with **P5 as the final cutover** (C1a deletion lands last, behind all merge gates). Reviewers
should be able to assess each phase in isolation rather than against one 75-commit diff.

**Blocker before reviewers assess final scope:** the PR description still says cached local layouts /
refinement are deferred and the system is *"fully functional"* — this **contradicts the merge gates**
(9/13/16) and **MUST be updated before reviewers assess final scope.**

## Risks

Local-layout perf at 1.39M-node scale (validate on Linux); budget reconciliation regressing the
expand-all fix (pin behind the bench); `collapseClusters` removal sequencing (only after generic
materialization is live); **intermediate-tier construction cost** (subdivision must itself be
incremental / cached on the material signature, or P0.5 reintroduces the per-recut O(N) it removes);
**edge-index memory** at 1.3M edges (boundary summaries must be bounded by fan-out, not by raw degree).
