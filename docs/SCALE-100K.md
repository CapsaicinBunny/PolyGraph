# Scaling PolyGraph to 100k+ nodes

Tracking doc for the effort to make PolyGraph analyze **and render** very large
codebases (target: `linux/drivers`, ~100k+ nodes). Today such a repo analyzes
slowly and **fails to render**.

## Diagnosis (why it fails today)

The render failure is overdetermined — three independent walls:

1. **Layout hangs first.** Default algorithm is `smart` → `dagre` on the one
   giant connected component. dagre is ~O(V·E), unusable past ~10k nodes, and
   there is **no node cap, no timeout, no cancellation** (`useScene.ts`). The
   layout overlay spins forever; no scene is ever produced.
2. **The JSON bridge would OOM next.** `VelloGraphCanvas` `JSON.stringify`s all
   ~100k nodes + ~200k edges on the main thread on every scene change (and even
   on a highlight toggle); the Rust side re-parses the same string.
3. **The Rust renderer's edge encoding overruns.** Edges have no viewport
   culling and every visible curve is re-encoded into the Vello scene every
   frame, overrunning the wasm32 allocator.

Root cause: **there is no level-of-detail / virtualization anywhere** — the full
node set is always laid out, serialized, and drawn.

## Design: "Nanite for graphs"

UE5 Nanite's core idea — _store the whole hierarchy once; each frame pick a
per-region cut where on-screen error is ~1px; do selection/culling next to the
GPU_ — maps onto a code graph almost 1:1, because a codebase **is** a hierarchy
(symbol → file → directory → package → workspace) and we already bundle
cross-cluster edges into counted aggregate edges.

| Nanite                           | Graph equivalent                                                                    | Status                            |
| -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| cluster DAG (LOD levels)         | symbol/file/dir/package hierarchy                                                   | exists (`levels/`, `collapse.ts`) |
| screen-space error picks the cut | a cluster opens to children only when its on-screen box is big enough to be legible | **new primitive**                 |
| GPU-driven cull + LOD select     | cut-selection + frustum cull **in the Rust/WASM renderer**                          | new                               |
| virtualized streaming            | only lay out + shape glyphs for clusters in the current cut                         | new                               |
| software raster of pixel tris    | — (Vello rasterizes vectors fine; we need _fewer elements_, not a new raster)       | n/a                               |

Payoff: rendered/laid-out element count tracks **screen real estate, not repo
size**.

## TS → Rust moves (numeric/per-frame work belongs in Rust)

1. LOD cut-selection + culling (the Nanite core) — in the renderer.
2. Layout (force/grid/hierarchical) — currently `dagre`/`d3-force` (JS); the hang.
3. Graph aggregation/collapse/community/SCC — O(N+E) transforms on the main thread.
4. Data bridge → typed arrays (zero-copy) instead of `JSON.stringify`.
5. Spatial index for `pick()`.

Stays in TS: the ts-morph provider (it _is_ the TS compiler), kernel
orchestration, React/Chakra UI, export serializers.

End-state: a single Rust "graph engine" (the `vello-renderer` crate grown into a
graph crate, shared with the napi `analyzer-core` on desktop, compiled to wasm in
the browser) owns the model, aggregation, LOD hierarchy, layout, culling, and
feeds Vello. TS shrinks to orchestration + analysis + UI.

## Phased plan (child PRs)

### v0 — make it render now (this epic)

- **[child] renderer quick wins** — viewport-cull edges; hoist font/charmap out
  of the per-frame `render()`. (`vello-renderer`)
- **[child] adaptive auto-collapse** — when a view exceeds a node threshold, seed
  the collapsed set with top-level directories so a huge repo renders as a few
  hundred aggregate cards (expand-on-click already works). (`lib/graph/scene.ts`)
- **[child] layout guard** — cap/ban `dagre` above a node threshold (fall back to
  a near-linear layout) and add a worker timeout so layout always terminates.

### v1 — adaptive LOD, all in TypeScript (renderer untouched)

A parallel design+feasibility workflow (3 proposals + 4 code-grounded probes +
a synthesis judge) chose the lowest-risk architecture: the cut is computed in
**pure TypeScript** and only changes WHICH directories are collapsed as the
camera zooms — the Vello renderer is byte-for-byte unchanged. Each visible
directory's box is read **straight from the live scene**, so the cut decision is
in the renderer's exact coordinate space and reuses the existing collapse→reflow
path. The camera is preserved on a recut (fit only on new graph/level/filters).
The typed-array bridge and a Rust-side cut were **deferred** — feasibility
confirmed the bridge isn't a v1 prerequisite once the cut holds card count
~constant (a few hundred nodes; `serde_json` is not the bottleneck).

### v2 — lazy hierarchical layout in Rust

- Lay out each cluster's interior on demand as the cut opens; move force/grid
  layout into the wasm engine with `rayon` (`wasm-bindgen-rayon`, COOP/COEP).
  Removes the last whole-graph cost.

## Status

v0 (make it render now) — child PRs against this epic:

- [x] renderer quick wins — edge cap + font hoist (#46)
- [x] adaptive auto-collapse — directory-depth LOD seed (#47)
- [x] layout guard — size cap + worker timeout (#48)

v1 (adaptive cut, renderer untouched):

- [x] LOD core — directory hierarchy + pure adaptive cut, fully unit-tested (#49)
- [x] camera-driven cut wiring behind an `adaptiveLod` flag, default off (#50)
- [ ] desktop calibration of the thresholds (`LOD_OPEN_PX`, `LOD_MAX_CARDS`,
      band step) and flip the flag default — needs a WebGPU run

v2 — not started. The typed-array bridge is also deferred (see v1). The master
PR (#45) tracks the live checklist.

### Analysis & safety track (separate PRs to main)

Orthogonal to the render epic — making the _analysis_ fast and safe at scale.
All verified (unit tests + `cargo check`) and composing cleanly together:

- [x] kernel ext→provider map, O(1) file lookup (#51)
- [x] parser-only syntactic diagnostics — drop the per-file whole-program
      type-check, the biggest analysis-time cost (#52)
- [x] dynamic `import()` resolution by symbol, not substring scan — fixes an
      O(N²) cost and a correctness bug (#53)
- [x] analyzer-core Rust hardening — `Arc<Query>` + `catch_unwind` (a worker
      panic no longer aborts the sidecar), surfaced parse errors, WAT ABI guard,
      parallel `build_graph` (#54)
- [x] concurrent directory reads (#55)
- [x] native `analyze` as a napi `AsyncTask` — buckets parse concurrently, JS
      thread not frozen (#56, stacked on #54)
- [x] size-gated ts-morph memory batching + `forgetNodesCreatedInBlock` — bounds
      memory for huge repos; normal repos byte-identical (#57, stacked on #52)

### Remaining frontier (needs a runtime / human sign-off — not blind-shippable)

- v1 threshold calibration + flipping the `adaptiveLod` default — needs a WebGPU run.
- Rebuild the native `.node` + the wasm so the async/LOD source changes take
  runtime effect (a build step, not code).
- NDJSON streaming of the scan response (sidecar↔browser) for the V8 ~512MB
  string ceiling — a wire-protocol change unverifiable here.
- v2 — lazy per-cluster layout / force-grid in wasm with `rayon`.
