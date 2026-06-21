# Representation-LOD Unification — Design Spec

> Status: **design, awaiting review** · 2026-06-21 · branch `feat/dimension-spine` (PR #77)
> Supersedes the dual-path (C1a collapse cut + C1b representation cut) LOD with a single
> **representation cut** as the sole level-of-detail system.

## Goal

Make the **representation cut** the one and only LOD. It must cover **every base** the old
camera-driven directory-collapse (`adaptiveLod` + the C1a `computeCut`/`computeGroupCut`
algorithm) covered, **fix the residual gaps** (ungrouped "None" is unbounded; the layout
re-runs globally on every recut → the expand-all hang/thrashing), and **retire** the old
algorithm — without bending the new system to be backwards-compatible. The old retires; the
new replaces; all edge cases keep working.

### Non-goals
- The Problems panel rewrite (separate, later) — here we only guarantee we don't break it.
- New grouping modes or filter semantics — those are the dimension-spine work, already shipped.
- Changing the scan/analyzer pipeline.

## Naming

UI: the single top-bar **"LOD"** toggle (already renamed). Internally: the **representation
cut** (`lib/graph/lod-representation-cut.ts`) and its **local-layout** assembly. `adaptiveLod`
remains the master on/off boolean; the separate `representationLod` selector flag is removed
(it is always-on now).

## Architecture

One budgeted **valid-antichain cut** over a per-mode **proxy hierarchy** chooses which
groups/nodes are *committed* (rendered + laid out) vs folded into aggregate cards. Its output
`openSelection: Set<GroupId>` flows through the **existing, unchanged** pipeline:

```
representation cut → openSelection → compose(intent, bootstrap, selection)
  → collapsedClusters → collapseClusters() → scene structure → layout
```

`compose()` (`lib/graph/collapse-model.ts`, mode-agnostic three-layer ownership) and
`collapseClusters()` (`lib/graph/collapse.ts`, absorbs files under closed groups into
aggregate cards) are the **shared glue and stay**. The cut is computed from graph structure +
the grouping snapshot + camera + budget — **never from the layout engine**, so it is identical
across Smart / Stress / Force / Backbone / Grid. That is the fix for "changing layout turns LOD
off": LOD is layout-independent.

### Current state (from the LOD core + surface maps)
- **Already wired (keep):** `buildSceneRepresentationCut` (VelloGraphCanvas ~845–862), the
  eviction LRU + deadband (`lib/graph/lod-eviction.ts`), intent→`forceClosed`/`forceOpen`
  constraints, Directory snapshot (canvas-built) + Community/Package/facet snapshots
  (`cutGrouping` prop). With `representationLod` const-true, the C1a branches are already dead.
- **Dead code to delete:** `computeGroupCut` (`lib/graph/group-cut.ts`), `computeCut`/
  `computeCutTraced` (`lib/graph/lod-cut.ts`), the C1a branches in `recomputeCut`
  (VelloGraphCanvas ~875–959), and the C1a `lod/cut` telemetry.
- **Built + unit-tested but UNWIRED (the upgrade):** `local-layout.ts` (`ProxyCacheKey`,
  `LocalLayoutCache`), `local-refine.ts` (`HierarchicalLayout`, `refineGroup`, `worldScene`),
  `overflow-ladder.ts` (`resolveOverflow`, the §C rungs, `global:false` invariant),
  `global-relayout.ts` (`globalLayoutSignature` material-change gate), `representation-bounds.ts`
  (Space-Paradox envelope caps). Confirmed: **zero production call sites.**

## Work item 1 — Wire the local layouts (the core upgrade)

Today every recut re-runs the **global** layout over the whole post-cut set (≤budget nodes).
On a borderline input or during min-zoom camera churn that exceeds the 8 s worker timeout (seen
3× in the logs) → the hang. Wire the staged C1c machinery so a recut **refines only the changed
group**:

- The scene's layout becomes a `HierarchicalLayout`: each committed group has a stable reserved
  **box origin** + a **cached local layout** keyed by `ProxyCacheKey` (material inputs only —
  never camera/LOD). `worldScene()` projects each group's local layout through its origin.
- A cut change that opens/closes one group calls `refineGroup` for **only that group**; every
  other group's world coordinates are **byte-identical** (the proven invariant). `worldScene`
  re-stitches. No global relayout.
- Overflow (a refined group outgrowing its reservation) escalates through `OVERFLOW_RUNGS`
  (scale → clip-pan → borrow-slack → grow-envelope → scoped-relayout), **never** to a global
  relayout (`global:false`, asserted). `representation-bounds` caps envelope growth (≤8×).
- A **global** relayout fires only on a true material change — `globalLayoutSignature` diff
  (graph / filters / grouping mode / direction / engine / density) — i.e. the things that today
  live in `scene.signature` + `fitSignature`. A camera recut touches none of these.

Result: the layout engine processes only the cut's nodes, incrementally; the expand-all hang and
min-zoom thrashing are gone at the root, positions stay stable, and the 8 s timeout is never
approached.

## Work item 2 — None gets a synthetic hierarchy

"None" grouping has no containers, so the cut is currently inert (unbounded). Build a lightweight
**synthetic proxy hierarchy** for None — `directory → kind` — emitted as a normal
`CompactGroupingSnapshot` via the existing `buildGroupingSnapshot` contract, but **rendered
flat** (the synthetic groups are cut proxies, not visible cards). Over budget, low-importance /
off-screen nodes fold into `+N` overflow proxies through the same machinery. None is now bounded
identically to grouped modes.

## Work item 3 — Retire C1a + unify tuning

- Delete the dead C1a functions/branches/telemetry listed above.
- Remove the `representationLod` selector; `adaptiveLod` is the sole master flag.
- Unify the duplicated budgets into the rep-cut options (single source in
  `lod-representation-cut.ts`): `LOD_NODE_BUDGET` (Explorer + VelloGraphCanvas — currently two
  copies at 1500), `LOD_MAX_CARDS` (800), `AUTO_COLLAPSE_MAX_CARDS` (2000). Document which is the
  initial-frame budget vs the steady-state hard ceiling.
- Keep `compose()` and `collapseClusters()` (still the glue between cut and render).

## Integration contracts (must honor)

| System | Contract |
|---|---|
| **Filters** | Cut operates on the **post-filter** scene. **Reuse the filtered community detection** (`communityOf` reported by the canvas) — re-running over the full graph relabels communities and breaks Community-mode LOD. |
| **Card animation + tracing** | Already robust: connection paths run on **code** edges (containment pre-filtered) and `pruneAnchors()` cleans endpoints when a region folds. Keep the **hidden-node→proxy** map (`activeProxyBoxKeyOfNode`) so selecting/tracing a folded node lands on its aggregate card. |
| **Layout** | The cut **must emit a box per committed group** or Smart degrades to Grid. Local layouts seed from the prior layout to preserve the mental map. |
| **Camera / fit** | `fitSignature` excludes the cut → recuts never re-frame. **Focus mode bypasses the cut** (focused nodes + their parent files always shown). |
| **Problems panel** | No change. It sets `focusedIds`; focus already bypasses the cut. (Its own rewrite comes later.) |

## Edge cases (preserved, verified in the map)

Huge-repo scan seeding (bootstrap = coarsest antichain), Reveal-detail (clears intent, re-seeds),
the `nodeCost = 1 + symbols` budget, camera-band recut + debounce + monotonic zoom-in, offscreen
auto-open eviction, the Grid/Backbone fallback (should not fire on a budgeted cut; keep the
guard), the 8 s worker timeout, mode-switch state isolation (`intent/bootstrap/selectionByMode`),
stale-group-id resilience after filter/mode change.

## Test strategy

- **Green bar:** the full suite (currently 1056) stays green at every task boundary;
  `bun test` + `bun run typecheck` + `bun run lint`.
- **New unit tests:** None synthetic-hierarchy bounding; local-refine wiring (open one group →
  every sibling byte-identical in `worldScene`); the box-per-committed-group invariant; the
  global-relayout gate (camera recut → no global relayout).
- **Parity/▸-better bench:** representation cut vs the (about-to-be-deleted) C1a on real repos —
  the new cut must produce an equal-or-strictly-better LOD scene; capture in `bench/`.
- **Integration:** filter change, zoom churn, expand-all, mode switch, workspace restore — no cut
  corruption, no layout timeout, stable camera.

## Risks / open questions

- **Local-layout perf at scale.** The per-group layouts must stitch fast enough that a recut is
  < a frame. Mitigation: cache by `ProxyCacheKey`; only the changed group re-lays-out. Validate
  on the 1.39M-node Linux scan.
- **Budget reconciliation.** Two `LOD_NODE_BUDGET=1500` copies + `AUTO_COLLAPSE_MAX_CARDS=2000` +
  `LOD_MAX_CARDS=800` must collapse into one coherent budget model without regressing the
  expand-all fix. Pin exact numbers during build, behind the bench.
- **`collapseClusters` longevity.** Once local-refine is wired, file-absorption could be replaced
  by proxy selection. Out of scope here; keep `collapseClusters` as the glue for now.

## Phasing (for the implementation plan / build swarm)

Dependency-staged, each phase independently green-gated, built by the 3-role pipeline
(builder → inspector/fixer → regression-guard), max parallel where files don't collide:

1. **P1 — None synthetic hierarchy** (pure; `lib/graph`, isolated). Bounds None.
2. **P2 — Local-layout wiring** (the big one): `HierarchicalLayout`/`worldScene`/`refineGroup`
   into `useScene`/scene path; overflow ladder + `representation-bounds` live; `global-relayout`
   gate replaces the ad-hoc re-layout trigger. Sequential-ish (touches the scene path).
3. **P3 — Retire C1a + unify tuning** (deletes dead code, single budget source). After P1/P2 prove
   the new cut covers their bases.
4. **P4 — Parity bench + integration tests + desktop calibration** (`canRefine` openPx, eviction
   budget on real repos).

P1 and the test scaffolding for P2 can run in parallel; P3 depends on P1+P2; P4 last.
