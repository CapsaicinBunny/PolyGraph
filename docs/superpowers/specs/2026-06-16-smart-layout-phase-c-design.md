# Smart Layout — Phase C Design (Semantic reduction via collapsible containers)

**Goal:** Let the user collapse a directory cluster (incl. `«external»`, test, generated dirs) into a single aggregate card, and expand it again — taming huge graphs by hiding interiors while keeping cross-cluster dependencies visible.

**Builds on:** Phases A/B. Key insight: **collapse is a pure graph transform applied before layout** — so the layout engine, worker, and most of the renderer are untouched.

---

## Mechanism

A collapsed directory's nodes are removed and replaced by **one aggregate node**; edges touching them are rerouted to that aggregate. Because the aggregate is just another graph node, the existing filter → `collapseClusters` → `buildView` → smart-layout → scene → renderer pipeline handles it with no layout/worker changes.

### `lib/graph/collapse.ts` (pure, tested)

```ts
export const AGG_SUFFIX = "#__agg__";
export const aggregateNodeId = (clusterId: string) => clusterId + AGG_SUFFIX;
export const isAggregateId = (id: string) => id.endsWith(AGG_SUFFIX);
export const clusterIdOfAggregate = (id: string) => id.slice(0, -AGG_SUFFIX.length);

export function collapseClusters(graph: GraphModel, collapsed: Set<string>): GraphModel;
```

- For each node, find its **outermost** collapsed ancestor directory (via directory prefixes of its id); if found, the node is *absorbed*.
- The aggregate node id is `"<clusterId>#__agg__"`. Crucially, `clusters.ts`'s `dirSegments` strips at `#`, so the aggregate's directory resolves to the **parent** of the collapsed dir — placing the aggregate card inside the correct parent cluster, with no box drawn for the (now empty) collapsed cluster.
- Aggregate node: `kind: "file"` (renders as a card), `label: "<lastSegment> · <fileCount>"`, `filePath: clusterId`. `fileCount` = absorbed file nodes (ids without `#`).
- Edges: remap each endpoint absorbed → its aggregate id; drop self-loops and dedupe (keep first kind).
- `collapsed.size === 0` or no absorptions → returns the input graph unchanged (cheap no-op).

### Wiring (mostly additive)

- **`lib/graph/scene.ts`** — `buildSceneStructure` gains a `collapsedClusters: Set<string>` param; applies `collapseClusters(sourceGraph, collapsedClusters)` before `buildView`. The aggregate node flows through as a normal file-style `SceneNode`. Signature adds `ser(collapsedClusters)` to the cache key.
- **`components/useScene.ts`** — threads `collapsedClusters` to `buildSceneStructure`.
- **`components/Explorer.tsx`** — `collapsedClusters: Set<string>` state + `handleToggleCollapse(clusterId)` (mirrors the `expanded` pattern); reset on new scan; passed to the canvas.
- **`components/VelloGraphCanvas.tsx`** — adds `id` to each cluster in the WASM payload; on click, route: id `"cluster:<id>"` → `onToggleCollapse(id)` (collapse); `isAggregateId(id)` → `onToggleCollapse(clusterIdOfAggregate(id))` (expand); else existing node select/expand.
- **`vello-renderer/src/lib.rs`** — `ClusterData` gains `id: String`; `pick` first tests each cluster's **header strip** (top ~26px) deepest-first and returns `"cluster:" + id` on a hit, before the existing node test. (Header click = collapse; clicking the aggregate card = expand.)

---

## Edge cases

- Collapsing a parent that contains already-collapsed children: the outermost-ancestor rule means the parent's aggregate absorbs everything; child collapse state is irrelevant while the parent is collapsed (and preserved for when it re-expands).
- An aggregate node with no surviving edges still renders (a lone card) — expected.
- Filters + collapse compose: collapse runs on the already-filtered graph, so hidden folders/languages never appear in counts.
- Determinism: aggregate ids/labels derive from sorted/stable inputs; edge dedupe iterates in graph order (already stable per scan).

## Testing

- **`lib/graph/collapse.test.ts`:** absorbs nodes under a collapsed dir into one aggregate; aggregate id/label/count correct; edges rerouted + deduped + self-loops dropped; outermost-ancestor wins when nested dirs both collapsed; empty collapsed-set is a no-op; symbols (`file#sym`) absorbed with their file.
- **`scene.test.ts` (if present) / manual:** a collapsed cluster yields an aggregate `SceneNode` and no box; non-collapsed unchanged.
- Renderer header-pick verified manually.

## Deferred

Auto-collapse by size threshold; "shortest-path-around-selected-node" reduction; distinct aggregate-card styling (uses the file card for now). These are later refinements.
