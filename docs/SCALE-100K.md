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

### v1 — adaptive LOD in Rust (the Nanite step)

- Ship the cluster **hierarchy** (bboxes + aggregate cards + child pointers +
  bundled edges) to the renderer once; Rust does per-frame **cut-selection +
  culling**; replace the JSON bridge with **typed arrays**.

### v2 — lazy hierarchical layout in Rust

- Lay out each cluster's interior on demand as the cut opens; move force/grid
  layout into the wasm engine with `rayon` (`wasm-bindgen-rayon`, COOP/COEP).
  Removes the last whole-graph cost.

## Status

v0 (make it render now) — child PRs open against this epic:

- [x] renderer quick wins — edge cap + font hoist (#46)
- [x] adaptive auto-collapse — directory-depth LOD seed (#47)
- [x] layout guard — size cap + worker timeout (#48)

v1 / v2 — not started (see the phased plan above). The master PR (#45) tracks the
live checklist.
