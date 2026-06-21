# Representation-LOD Unification — Design Spec (Rev 2)

> Status: **design, awaiting review** · 2026-06-21 · branch `feat/dimension-spine` (PR #77)
> Rev 2 incorporates an expert implementation review. Direction (one LOD = the representation
> cut, retire C1a) is **strongly approved**; the cut is **not yet safe to make sole / delete the
> old path** until the correctness + scalability gates below are met. Rev 1 underestimated the
> work; the corrected order proves coverage *before* deletion.

## Goal

Make the **representation cut** the one and only LOD — covering every base the old
camera/directory-collapse (`adaptiveLod` + C1a `computeCut`/`computeGroupCut`) covered, fixing
its gaps (ungrouped None unbounded; layout re-runs globally each recut; not actually
layout-independent), and **retiring** C1a. The old retires; the new replaces; no backwards-compat
compromises — but **only after** the gates prove the replacement is real in every mode.

### Non-goals
Problems-panel rewrite (separate; only don't break it), new grouping/filter semantics, the scan
pipeline.

## Architecture (target)

One budgeted **valid-antichain cut** over a **persistent, post-filter representation hierarchy**
selects which proxies are committed (rendered + locally laid out) vs folded. Target flow:

```
persistent RepresentationRuntime (cached by material signature, post-filter)
  → solveLodCut (finite budgets, marginal-cost priority)
  → openSelection / committed reps
  → GENERIC proxy materialization (active-representative per node → proxy cards + aggregated edges)
  → scene
  → LOCAL layouts (per-group cached, stitched; cut-diff drives incremental refine)
```

The cut is computed from structure + snapshot + **stable proxy geometry independent of the visual
layout engine** + camera + budget — never from the engine name *or* from live cluster boxes that
only some engines produce. That is what makes it genuinely layout-independent.

What stays: `compose()` (mode-agnostic three-layer ownership). What must be **replaced, not
reused as-is**: `collapseClusters()` (directory/community-only; see Gap 1).

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
   does not fix this. **Cache a persistent `RepresentationRuntime`** (hierarchy, nodeIds,
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

## Finite budget model (replaces Gap 6)

One production budget; exact numbers pinned by the P4 bench, but finite — `Infinity`/`totalNodes`
are not limits:

```ts
const LOD_BUDGET = {
  targetNodes: 800,  targetEdges: 8_000,  targetLabels: 500,
  hardNodes: 2_000,  hardEdges: 25_000,   hardLabels: 2_000,
  maxLayoutWork: 2_500, maxGpuBytes: 128 * 1024 * 1024,
};
```
Soft targets steer; finite hard ceilings cap forced opens; when intent can't be honored within the
hard ceiling, surface **"Detail limited"** rather than silently expanding.

## Local-layout orchestration (P3 — more than `refineGroup()`)

A committed cut may open AND close several proxies. Integration needs a **cut diff**:

```ts
interface CutDiff { refined: number[]; coarsened: number[]; unchanged: number[]; }
```
Then: compute local-layout cache keys → reuse hits → start cache-miss **worker** jobs → **reject
results from stale cut generations** → commit the scene atomically *or* support progressive
proxy→detail replacement → preserve all unaffected group origins (byte-identical). Plus: cache
memory limit / LRU, cancellation of obsolete requests, **generation tokens** in worker responses,
and a clear cut-commit-vs-layout-ready rule. The overflow ladder stays scoped (`global:false`); a
cut change **never** launches a full-repository layout.

**Perf objective** (not "every recut within a frame"):
`cut solve < 8–16 ms` · `cut diff + scene stitch < 16 ms` · `cached refinement < 16 ms` ·
`uncached layout = async, cancellable, proxy stays visible meanwhile`.

## Integration contracts (must honor)

Filters: cut on the **post-filter** scene; **reuse filtered community detection** (re-running
relabels communities → breaks Community LOD). Animation/tracing: already robust (paths on code
edges, `pruneAnchors` on fold); keep the **hidden-node→proxy** map (`activeProxyBoxKeyOfNode`).
Layout: **box per committed group** or Smart→Grid; seed from prior layout. Camera/fit: excludes
the cut (recuts never re-frame); **focus mode bypasses the cut**. Problems panel: **no change**
(sets `focusedIds`; focus already bypasses).

## Edge cases (preserved)

Huge-repo scan seeding, Reveal-detail, `nodeCost = 1 + symbols`, camera-band recut/debounce/
monotonic zoom-in, offscreen eviction, Grid/Backbone fallback (keep guard), 8 s worker timeout,
per-mode state isolation, stale-group-id resilience.

## Revised implementation order (P0 → P5)

- **P0 — Correctness + persistent runtime** *(before None or local layouts).* Cache
  `RepresentationRuntime` by material signature; cache node ordinals + group-id maps; make the
  hierarchy **post-filter**; fix the solver's marginal **delta-cost** + **continue-after-oversized**;
  define **finite hard budgets**; add **pan-end visibility recuts**.
- **P1 — Generic proxy materialization.** Replace directory/community-specific absorption with
  active-representative-per-node → proxy nodes + aggregated edges → scene. *This is what makes
  Package, facet, Community, and None genuinely work.*
- **P2 — Synthetic None + layout-independent proxy bounds.** Wire the existing
  components→communities hierarchy; invisible container geometry; stable proxy bounds independent of
  the visual engine; remove the `boxes.size === 0` escape; bench vs directory→kind before changing.
- **P3 — Local-layout orchestration.** Cached per-group layouts; cut diffing; batch refine/coarsen;
  async generation cancellation; overflow ladder (scoped only); cache eviction.
- **P4 — Budget consolidation + parity bench.** Old vs new on: visible info at equal node budget;
  edge count/aggregation; cut-solve / scene-build / layout time; # camera-induced global moves;
  intent correctness; **all grouping modes**; **filtered graphs**; **panning as well as zooming**.
- **P5 — Delete C1a.** Remove `lod-cut.ts`, `group-cut.ts`, `lod-selection.ts`, the C1a telemetry +
  canvas branches, the duplicated budget constants, and the `representationLod` prop entirely.

P1 plus P2 test scaffolding can parallelize; P3 depends on P0–P2; P4 then P5 are sequential.

## Merge gate (do not delete C1a / merge until ALL hold)

1. Representation hierarchy **persistent** across camera recuts. 2. Proxy materialization works for
**Directory, Community, Package, facet, None**. 3. None + non-Smart layouts have usable proxy
bounds. 4. Cut costs use the **post-filter** graph. 5. Solver uses **actual marginal** refinement
cost. 6. A too-large candidate **does not block** smaller ones. 7. **Finite** hard budgets. 8.
**Pan-end** updates retention/eviction. 9. Local-layout cache misses are **async + generation-safe**.
10. A cut change **never** launches a full repository layout. 11. **Parity benchmarks pass** on real
repos. 12. **Real CI runs green** — the PR currently shows a completed workflow with **no jobs**
(test totals live only in commit/PR text); a 75-commit architectural PR needs an actual CI job
(GitHub Actions running `bun test` + `typecheck` + `lint`) before merge.

## Risks

Local-layout perf at 1.39M-node scale (validate on Linux); budget reconciliation regressing the
expand-all fix (pin behind the bench); `collapseClusters` removal sequencing (only after generic
materialization is live).
