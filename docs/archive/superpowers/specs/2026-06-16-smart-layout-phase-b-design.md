# Smart Layout — Phase B Design (Adaptive per-cluster + SCC collapse)

**Goal:** Make each cluster lay out by the *shape* of its internal dependency graph, and handle circular dependencies gracefully instead of letting dagre break cycle edges arbitrarily.

**Builds on:** Phase A ([2026-06-16-smart-layout-design.md](2026-06-16-smart-layout-design.md)) — the recursive `layoutCluster` in `lib/layout/smart.ts`, which currently places every cluster's items with `dagreItems`. Phase B replaces that single call with: collapse SCCs → choose a mode → lay out. **Pure TypeScript; no renderer changes** (SCC groups are not directories, so they get no container box — the cycle is conveyed by a ring of nodes).

---

## Decisions (from brainstorming)

- **SCC collapse: always.** Detect strongly-connected components among a cluster's items (Tarjan), collapse each multi-member cycle into a temporary **super-item**, lay out the acyclic **condensation**, then expand each super-item's members into a ring inside its slot.
- **Adaptive mode (3 top-level modes):** on the condensation graph, pick **grid** (no edges), **force** (dense/tangled), or **layered** (default; the condensation is a DAG, so dagre ranks it cleanly). **Circular** is used only *inside* SCC super-items. Per-cluster **radial** is dropped (low payoff, fuzzy detection).

---

## Architecture

### New module: `lib/layout/scc.ts` (pure)

```ts
export interface Scc { id: string; members: string[] }   // members in deterministic (sorted) order

/** Tarjan's SCC over a directed item-graph. Returns components; singletons included. */
export function stronglyConnectedComponents(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): Scc[];
```

- Tarjan with iterative (explicit-stack) traversal to avoid deep recursion on large clusters.
- Deterministic: iterate `nodeIds` and each node's out-adjacency in **sorted** order; component `id` = `"scc:" + members.sort().join("|")` (stable).
- Singletons (no cycle) come back as 1-member components — callers treat `members.length === 1` as a normal item.

### Item-size-aware layout helpers in `lib/layout/smart.ts`

Phase A has `dagreItems(items, edges, direction) → centers`. Add three siblings with the same signature shape (`items: {id,width,height}[] → Map<id, center>`), adapted from the existing algorithms in `lib/layout.ts` but operating on arbitrary item sizes:

- `gridItems(items)` — row-major grid; cell = max item size + gap. (No edges needed.)
- `circularItems(items)` — items evenly spaced on a ring; radius from summed item extent so boxes never overlap. Used for SCC rings.
- `forceItems(items, edges)` — d3-force with `forceCollide` radius from each item's half-diagonal; fixed tick count (deterministic, no RNG — d3 seeds initial positions via its deterministic phyllotaxis). Adapted from `forceLayout` in `lib/layout.ts`.

All return **centers** (like `dagreItems`), so the existing center→top-left conversion in `layoutCluster` is unchanged.

### Revised `layoutCluster` step 4 (the only changed logic)

Replace the single `dagreItems(items, sortedEdges, direction)` with:

```
1. components = stronglyConnectedComponents(item ids, sortedEdges)
2. For each multi-member component: lay its members out with circularItems →
   member centers (local); the super-item's size = bounding box of that ring.
   Build superId → {members, memberCenters, width, height}.
   Map each member id → its superId.
3. condensationItems = singletons (original size) + super-items (ring bbox size).
   condensationEdges = sortedEdges remapped to super ids, self-edges + dups dropped,
   then sorted (determinism).
4. mode = chooseMode(condensationItems.length, condensationEdges.length):
     edges == 0            → "grid"
     edges  > n * 1.6      → "force"
     else                  → "layered"
5. centers = { grid: gridItems, force: forceItems, layered: dagreItems(...,direction) }[mode]
6. Expand: for a singleton, its center is the item center.
   For a super-item, place each member at superCenter + (memberLocalCenter − ringLocalCenter).
   Produce the same `centers: Map<itemOrMemberId, center>` the rest of step 5/6 expects.
```

Everything after (top-left conversion, child-content offset, normalization, box sizing) is **unchanged** — it already iterates `items` and reads `centers.get(id)`. Note: child-cluster items are never part of an SCC ring (clusters are nodes-only in the item-graph? No — child clusters CAN be in cycles too). **A super-item may contain child-cluster items as well as direct nodes**; the ring places each by its box size, and child-cluster contents are offset by the member's placement exactly as singletons are. This is handled by keeping the existing per-item branch (`it.child` vs direct node) and just feeding it the expanded center.

### `chooseMode`

```ts
type Mode = "grid" | "force" | "layered";
function chooseMode(n: number, m: number): Mode {
  if (m === 0) return "grid";
  if (m > n * 1.6) return "force";
  return "layered";
}
```

Threshold `1.6` is a heuristic (a clean DAG has `m ≈ n`; dense/tangled graphs exceed it). Documented as tunable.

---

## Edge cases

- **Self-loops** (a node importing itself) — dropped when building the item-graph (Phase A already drops `su === sv`); never form an SCC.
- **Whole cluster is one big cycle** — one super-item fills the cluster; condensation has 1 node, 0 edges → grid of one → trivially placed; members ring inside. Reads as a circular cluster, which is correct.
- **Force determinism** — fixed iteration count + no `Math.random`; assert reproducibility in tests.
- **Large cluster** — Tarjan is iterative (no stack overflow); force runs only when chosen (dense clusters are usually small after SCC collapse).
- **Direction** — only `layered` (dagre) uses TB/LR; grid/force/circular ignore it (expected).

---

## Testing (`lib/layout/scc.test.ts`, additions to `lib/layout/smart.test.ts`)

- **scc.ts:** `a→b→a` → one 2-member component; `a→b→c→a` → one 3-member; a DAG `a→b→c` → three singletons; disconnected nodes → singletons; deterministic component ids.
- **smart.ts adaptive:**
  - A cluster whose files form a cycle (`x→y→z→x`) → all three still land inside the cluster box, none overlapping, output deterministic across two runs.
  - A cluster with files but **no** intra-cluster edges → grid-placed, no overlaps.
  - A dense cluster (≥ n*1.6 edges) → force-placed, contained, deterministic.
  - Existing Phase A invariants (containment, no sibling overlap, empty graph) still pass.

No renderer or worker changes; the worker already returns `{nodes, clusters}` and clusters are unchanged by Phase B.

---

## Deferred to later phases

Per-cluster radial; drawing a visible affordance around SCC rings (a dashed "cycle" outline); C (semantic reduction), D (edge routing/bundling), E (control panel + community detection).
