# Smart Layout (`semanticMultilevel`) — Design

**Goal:** Add a "Smart" layout that uses the *meaning* of a code graph — its
package/directory structure and dependency flow — instead of forcing every graph
into one geometric pattern. The result reads like an architecture explorer:
nested package containers, each laid out by dependency flow, with files inside.

**Status:** Multi-phase. This document is the shared north-star architecture plus
the detailed, buildable design for **Phase A** (the foundation). Phases B–E get
their own specs as we reach them; all share the contract defined here.

---

## Background — current state

Layout today is a pure function `layoutView(LayoutInput) → Map<id,{x,y}>`
([lib/layout.ts](../../../lib/layout.ts)). It already splits a graph into
connected components, lays each out with a chosen algorithm, and **shelf-packs**
the results ([lib/layout.ts:166](../../../lib/layout.ts) `layoutByComponents`).
The Smart pipeline is the same *shape* — group → lay out each group → lay out the
groups → place — but with **semantic** groups (directories) and a **meaningful
coarse layout** (dagre over the cluster dependency graph) instead of blind
packing.

Data flow: `buildSceneStructure` (pure) → `layoutInWorker` (Web Worker) → `Scene`
→ Vello WASM payload `{nodes, edges}` → renderer. Node ids encode their file path
(`path/to/file.ts` for files, `path/to/file.ts#symbol` for symbols), so a node's
directory ancestry is derivable from its id with **no new plumbing from the
analyzer**.

The renderer ([vello-renderer/src/lib.rs](../../../vello-renderer/src/lib.rs))
parses the payload into `GraphData { nodes, edges }`, draws edges first (under the
cards), then nodes as `RoundedRect` cards, plus GPU vector text. Adding container
rectangles reuses primitives already present.

---

## North-star architecture

### The one foundational change: layout returns clusters

The layout contract grows from positions-only to a structured result:

```ts
interface LayoutResult {
  nodes: Map<string, XYPosition>;   // top-left positions, as today
  clusters: ClusterBox[];           // every directory box, all nesting depths
  edges?: Map<string, Point[]>;     // routed polylines — Phase D; absent until then
}

interface ClusterBox {
  id: string;            // cluster path, e.g. "src/lib/graph"
  parentId?: string;     // enclosing cluster id, or undefined for top-level
  x: number; y: number;  // top-left, world space
  width: number; height: number;
  depth: number;         // 0 = top-level box; increases inward
  label: string;         // segment shown in the header, e.g. "graph"
}
```

This threads through: worker protocol → `Scene.clusters` → Vello payload
`{nodes, edges, clusters}` → renderer draws nested containers behind edges/nodes.

### The pipeline (recursive over the directory tree)

```
buildClusterTree(nodes by directory ancestry, compress single-child chains)
  → [Phase C] semantic reduction: collapse externals/tests/generated, hide isolates
  → layoutCluster(root) recursively:
       items = child clusters (as boxes) + direct nodes (as boxes)
       [Phase B] collapse SCCs among items → super-nodes
       [Phase B] adaptive choice: layered | force | radial | circular by item-graph shape
       dagre over items using their sizes + inter-item edges (directional)
       box = bounds(items) + padding + header height
  → [Phase D] route + bundle edges
```

Phase A implements this with dagre at every level and straight edges.

### Build sequence (each phase independently shippable)

- **Phase A — Foundation.** Nested directory grouping → recursive multilevel
  layout (dagre internal + dagre coarse) → `LayoutResult` with cluster boxes →
  Vello draws nested containers + labels → "Smart" in the layout list. Straight
  edges. *Delivers the architecture-explorer view on its own.*
- **Phase B — Adaptive + SCC.** Per-cluster algorithm selection by item-graph
  shape; collapse strongly-connected components to super-nodes for internal layout.
- **Phase C — Semantic reduction.** Collapse externals / tests / generated into
  aggregate nodes; container collapse/expand on click.
- **Phase D — Edge routing & bundling.** Curved / bundled / orthogonal routing in
  the renderer (populates `LayoutResult.edges`); fade long-distance edges.
- **Phase E — Control panel + community detection.** GROUP BY
  (package/directory/namespace/community), FLOW, DENSITY, ROUTING controls;
  community detection as an alternative `groupBy`.

---

## Phase A — detailed design

### A1. Cluster-tree construction (pure, `lib/layout/clusters.ts`)

Input: the `LayoutInput` nodes (each `{id, kind}`). For each node, derive its
**directory segments** from the id: strip a trailing `#symbol`, take the path
before the last `/`. A node with no `/` (repo-root file) has no directory and
belongs to the **root** cluster (which is the canvas itself — not drawn).

Build a tree of `ClusterNode { id, label, children: ClusterNode[], nodeIds:
string[] }` keyed by cumulative path. A node lands in the **leaf** cluster equal
to its full directory; ancestor directories become enclosing clusters.

**Single-child compression:** if a cluster has exactly one child cluster and no
direct nodes, merge it with that child and join labels with `/` (e.g.
`src` → `lib` → `graph` becomes one box labelled `src/lib/graph`). This keeps
nesting meaningful instead of producing chains of one-child boxes.

External nodes (`kind === "external"`) group under a synthetic top-level cluster
`«external»` so third-party deps read as one region rather than scattering.

### A2. Recursive layout (`lib/layout/smart.ts`, runs in the worker)

`smartLayout(view: LayoutInput, { direction }): LayoutResult`

Unified recursion — every cluster is laid out the same way:

1. **Items** of a cluster = its child clusters (each already laid out, contributing
   its box `width`/`height`) **plus** its direct nodes (each contributing
   `nodeSize(kind)`).
2. **Item graph:** map every underlying node to the item (child cluster or direct
   node) it belongs to *within this cluster*. Add an item-edge `I→J` when any
   underlying edge connects a member of `I` to a member of `J` (drop self-edges).
3. **Place items** with the existing `dagreLayout` (reused as-is), passing each
   item's `width`/`height` as its node size and `direction` as rankdir. dagre
   returns item centers.
4. **Offset** each item's internal contents by `(itemCenter − itemLocalCenter)`,
   accumulating translations down the tree so leaf node positions end up in world
   space.
5. **Box** for this cluster = bounding box of placed items + uniform `PADDING`
   on all sides + `HEADER_H` extra at the top for the label. Emit a `ClusterBox`
   for every non-root cluster, with `depth` from the recursion level.

Leaf clusters are just the base case (items are all direct nodes). The root
cluster runs the same step but emits **no** box (it is the canvas); its children
become the top-level boxes (`depth: 0`).

Constants: `PADDING = 24`, `HEADER_H = 26`. Reuse `nodeSize`, `topLeft`, and
`dagreLayout` from [lib/layout.ts](../../../lib/layout.ts).

`layoutView`'s signature is **unchanged** — it keeps returning a `Positions` map
for all seven algorithms (the `"smart"` case calls `smartLayout` internally and
returns just its `nodes` map). `smartLayout` is exported separately so the worker
can obtain the `clusters` too; the worker (below) branches on the algorithm to
package both into its result.

### A3. Worker protocol (`lib/layout-client.ts`, `lib/layout.worker.ts`)

Today the worker returns `FlatPositions = [id, x, y][]`. Extend the response to
also carry clusters:

```ts
interface WorkerResult {
  positions: [string, number, number][];
  clusters: ClusterBox[];   // empty for non-smart algorithms
}
```

`layoutInWorker` resolves `{ positions: Map, clusters: ClusterBox[] }`. Inside the
worker (and the no-Worker main-thread fallback): if `algorithm === "smart"`, call
`smartLayout` and use its `nodes` + `clusters`; otherwise call `layoutView` and
return `clusters: []`.

### A4. Scene (`lib/graph/scene.ts`)

- `SceneStructure` / `Scene` gain `clusters: ClusterBox[]` (carried straight
  through — no per-cluster styling field in Phase A; the renderer derives the fill
  tint from `depth`).
- The layout cache value becomes `{ positions, clusters }`; `layoutCacheGet/Set`
  and `useScene` store and restore both.
- `applyPositions` copies `clusters` straight through onto the `Scene` (clusters
  are already in world space; only nodes need position application).

### A5. Renderer (`vello-renderer/src/lib.rs` + payload)

- Payload `{nodes, edges}` → `{nodes, edges, clusters}` where each cluster is
  `{ x, y, w, h, depth, label }`. `VelloGraphCanvas` adds `clusters` to the
  memoized payload from `scene.clusters`.
- `GraphData` gains `clusters: Vec<ClusterData>`. Render order becomes
  **clusters (ascending depth, so parents draw under children) → edges → nodes**,
  all under the same camera affine as nodes (world space).
- Each container: a `RoundedRect` (corner ~14) with a **faint depth-tinted fill**
  (alpha ~0.04–0.07, deeper = slightly stronger) and a subtle 1px border in the
  card-border color. The `label` is drawn in the top-left header using the
  existing GPU-text path, in the muted foreground color.
- Containers must not capture clicks/picking — `pick_at` still iterates only
  `nodes` (unchanged). Fit-to-view still uses node bounds (clusters wrap nodes, so
  this stays correct).

Rebuild the WASM (`vello-renderer/pkg`) as part of the change.

### A6. UI (`lib/layout.ts`, `components/Sidebar.tsx`)

- Add `"smart"` to `LayoutAlgorithm` and to the algorithm selector, labelled
  **"Smart"**, listed first. It is **not** in `DIRECTIONAL_ALGORITHMS`'s gate for
  hiding direction — Smart *uses* `direction` (TB/LR) for both coarse and internal
  dagre, so the direction selector stays visible for Smart.
- No new controls in Phase A (GROUP BY / DENSITY / ROUTING arrive in Phase E).

### A7. Edge cases

- **Repo-root files** (no directory): live in the root cluster → no enclosing box,
  laid out among the top-level items.
- **A cluster with both child clusters and direct files** (files directly in a dir
  that also has subdirs): handled natively — direct files are items alongside
  child boxes in the same dagre pass.
- **Empty / single-node graph:** root has one item; no boxes or one box; must not
  divide-by-zero (guard like the existing algorithms).
- **Filtered views:** clusters are built from whatever nodes survive filtering, so
  hiding a folder/language simply removes its box.
- **Determinism:** dagre is deterministic for fixed input; cluster-tree iteration
  uses sorted keys so output is stable (required by the layout cache + tests).

### A8. Testing (`lib/layout/clusters.test.ts`, `lib/layout/smart.test.ts`)

Pure-function unit tests in the existing `bun test` style:

- **Cluster tree:** ids `["a/b/f.ts", "a/b/f.ts#x", "a/c/g.ts"]` → root with one
  compressed child `a` containing leaf clusters `a/b` and `a/c`; node membership
  correct.
- **Single-child compression:** `["src/lib/graph/x.ts"]` → one box labelled
  `src/lib/graph`, not three nested boxes.
- **Containment invariant:** every node's box lies within its leaf cluster box
  (incl. padding/header); every child box lies within its parent box.
- **No sibling overlap:** boxes of sibling clusters do not intersect.
- **Determinism:** identical input → identical `LayoutResult` across runs.
- **Non-smart unaffected:** `layoutView(view, {algorithm:"layered"})` still
  returns positions and the worker reports `clusters: []`.

Renderer container drawing is verified manually against a known repo (e.g. this
one): top-level boxes for `app/`, `components/`, `lib/`, `src-tauri/`, files
nested inside, dependency flow left-to-right.

---

## Deferred (explicitly out of Phase A)

SCC collapse, adaptive per-cluster algorithm, semantic reduction / aggregate
nodes, container collapse-expand interaction, edge routing/bundling, the GROUP BY
/ FLOW / DENSITY / ROUTING control panel, and community/namespace grouping. Each
is a later phase building on the `LayoutResult` + cluster-tree foundation above.
