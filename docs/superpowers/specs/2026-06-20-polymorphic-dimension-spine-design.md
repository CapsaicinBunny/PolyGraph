# Polymorphic Dimension Spine — Filters, Groups, Facets & Representation LOD — Design

**Goal:** Re-architect the **filters** and **group/LOD** systems around (a) a single
language-agnostic **Dimension** model so controls are *intelligent* (mean something for
every language), *honest*, and *polymorphic* (each provider contributes its own
dimensions); and (b) a **representation-LOD** model so large graphs render as a *budgeted
cut through a hierarchy of cached proxies* — not a sophisticated expand/collapse. Fast but
safe.

**Status:** Multi-phase north-star. **Revision 4.** (Numbering note: prior commits lagged
the review rounds — this is the doc after the *third* review.) Evolution: R1 split the
serializable catalog from the runtime index, made bootstrap-collapse not user intent, added
mode-namespaced ids, the grouping snapshot, None's internal hierarchy, bounded LOD, merge
rules, two-stage config validation, group-by eligibility. R2 (rev "3" commit) added
columnar/interned storage, the catalog label/color handshake, the dual-write parity
invariant, LOD hysteresis. **R4 adds:** the model/runtime/transport split for facet storage;
`CompactGroupingSnapshot` over transferable typed arrays; split `MissingPolicy`; sparse
`FacetSelection`; a core-owned canonical registry; closed-domain `declared:false` (no domain
drift); the **Representation Hierarchy + budgeted antichain cut** (proxies, error-per-cost,
edge/label LOD, committed-cut generations, stable local layout); and the C1→C1a/b/c split.

**Non-negotiables:**
- Deep spine: generalize `role`/`category`/`environment`/`runtime` into a generic
  provider-contributed facet model; every consumer projects from it.
- Group modes (Directory / Package / Community / facet / None) are **peers**; LOD works for
  all (None via a synthetic internal hierarchy).
- LOD is a **valid antichain cut** through a representation hierarchy — every underlying node
  represented exactly once (never a proxy *and* its expanded children; never an unrepresented
  subtree) — chosen by **error-per-cost** under **independent node/edge/label/GPU/layout
  budgets**, defaults **on**, perceptually monotonic around the viewport, budget-bounded.
- Collapse is **three-layered**: user `intent` (only), `bootstrapClosed` (derived safety),
  and the camera's `LodCut`. User intent wins; **bootstrap is not intent**.
- **Boundary discipline:** durable/persisted data (workspace, `AnalyzeResult` catalog) is
  **plain JSON**; high-volume **worker IPC** uses structured-cloneable / **transferable typed
  arrays** via a codec (so the columnar-memory goal isn't undone by JSON).
- A global relayout happens only on a *material* change (filters/grouping-mode/direction/
  explicit request/overflow) — **never** for an ordinary camera-driven refinement.
- Fast but safe: ordinal/columnar indexes built lazily; phased delivery; the 547 existing
  tests stay green at every phase boundary.

---

## Background — current state

`GraphNode` ([lib/graph/types.ts:84](../../../lib/graph/types.ts)) has a language-neutral
`kind` plus four optional facet fields that are JS/TS-only: `role`
([lib/analyzer/roles.ts](../../../lib/analyzer/roles.ts)), `category`
([nodes.ts:64,72](../../../lib/analyzer/nodes.ts); Rust core hardcodes `"feature"` at
[analyzer-core/src/lib.rs:459,471](../../../analyzer-core/src/lib.rs)), `environment` and
`runtimes` ([facets.ts:54,98](../../../lib/analyzer/facets.ts)). Production is two sites (TS
analyzer; Rust `build_graph()` [src/lib.rs:439-476](../../../analyzer-core/src/lib.rs), the
single pack→node site, no facet mechanism). Consumption is ~10 sites each re-hardcoding the
enums (query [evaluate.ts:148](../../../lib/graph/query-language/evaluate.ts); rules
[selector.ts:10](../../../lib/rules/selector.ts) + config
[load.ts:22-63](../../../lib/config/load.ts); scene gate
[scene.ts:162](../../../lib/graph/scene.ts); Sidebar/Explorer constants; visual
[visual.ts:12-117](../../../lib/graph/visual.ts)).

Group/LOD fragility: `collapsedClusters` is one set with five writers
([Explorer.tsx:353,324/335,436,722,388](../../../components/Explorer.tsx)); `adaptiveLod` is
dual-owner (off under 2000 cards); the camera cut is Directory-only
([VelloGraphCanvas.tsx:655,661](../../../components/VelloGraphCanvas.tsx)); Smart derives the
cluster tree internally and branches on Directory/Community/None
([lib/layout/smart.ts](../../../lib/layout/smart.ts)). The layout **algorithms** and the
Vello renderer affine ([vello-renderer/src/lib.rs:269](../../../vello-renderer/src/lib.rs))
are correct; the perceived direction flip is out of scope.

---

## North-star: the Dimension model

A **Dimension** is any axis you can filter, group, query, or style by. **Structural** ones
(`kind`, `language`, `folder`, `package`) are universal and derived; **facet** ones
(`role`, `category`, `env`, `runtime` now; per-language later) are provider-contributed.

### Three representations of facet data *(review §1)*
The model, the runtime index, and the wire codec are **distinct schemas** — never conflated:

```ts
// 1. MODEL — the external graph contract. Plain strings. Human-readable, JSON-durable.
export interface GraphNode {
  // …id, kind, label, filePath, line, parentFile…
  facets?: Record<FacetKey, string[]>;     // sparse (omit empty); kind stays first-class
}

// 2. RUNTIME — columnar, interned. Built from (graph + catalog). Never serialized as-is.
//    Per-dimension Uint32Array postings keyed by node ordinal; values interned to ids.

// 3. TRANSPORT — when facet/grouping data crosses the Worker boundary, a codec produces
//    structured-cloneable typed arrays + a shared string table (Transferable), NOT JSON.
export interface FacetWireData {
  stringTable: string[];          // id → string
  nodeOffsets: Uint32Array;       // CSR offsets into (keyIds,valueIds) per node ordinal
  keyIds: Uint32Array;
  valueIds: Uint32Array;
}
```
`node.facets` (strings) is the interchange/durable shape; the `DimensionIndex` holds the
interned columnar form; `FacetWireData` is the transport codec. Index-valued data is **never**
called `GraphNode.facets`.

### `GraphNode.facets` + dual-write migration *(review)*
Because nodes cross Rust → sidecar → client → worker → workspace, the migration **dual-writes**
the legacy field and the facet — not a derived getter (getters don't survive JSON):

```ts
{ environment: "client", facets: { env: ["client"] } }   // during A–C
```
All facet writes route through **one** `writeFacet(node, key, values)` helper that sets the
legacy field *and* `facets[key]` together; a graph-wide **parity invariant** test asserts
`legacy === facets`-derived for every node throughout A–C. Legacy fields are removed only
after every consumer reads `facets` (end of Phase D).

### Serializable catalog vs. runtime index *(review §1, §13)*
```ts
export interface DimensionCatalog { descriptors: DimensionDescriptor[]; }   // JSON, travels with AnalyzeResult

export interface DimensionValue { value: string; label: string; color?: string; glyph?: string; }

export interface MissingPolicy {            // §3 — filtering and grouping differ
  filter: "include" | "exclude" | "unclassified";
  group: "unclassified" | "exclude";
}

export interface DimensionDescriptor {
  key: FacetKey;                            // "role","env","rust.visibility","directory"
  label: string;                            // REQUIRED (handshake): missing label = analysis error
  dimension: "structural" | "facet";
  cardinality: "single" | "multi";
  domain: "closed" | "open";
  values: DimensionValue[];                 // [] for open
  providerIds: string[];                    // merged contributors
  canonicalKey?: CanonicalFacetKey;         // §5 — validated against the core registry
  filterable: boolean;
  groupable: boolean;
  grouping: FacetGrouping;                  // §multi-valued
  missing: MissingPolicy;
}

// RUNTIME-only — reconstructed deterministically; holds typed arrays; never serialized.
export interface DimensionIndex {
  descriptor(key: FacetKey): DimensionDescriptor | undefined;
  present(key: FacetKey): ReadonlyArray<PresentDimensionValue>;   // §6
  valuesOf(node: GraphNode, key: FacetKey): readonly string[];    // structural via adapter
  nodesWith(key: FacetKey, value: string): Uint32Array;           // columnar posting
  readonly warnings: ReadonlyArray<CatalogWarning>;
}

export interface PresentDimensionValue { value: string; declared: boolean; }   // §6
```
`AnalyzeResult` gains `dimensions: DimensionCatalog`. Client, CLI, and rule engine each build
the **same** `DimensionIndex` from `(graph, catalog)`.

### Index & memory *(review §13 + R2/R4)*
- Stable node **ordinals**; postings are `Uint32Array`; built **lazily** for dimensions that
  are present AND (`filterable`|`groupable`) AND requested.
- Values **interned** to ids; closed single-cardinality domains may pack into a bitmask/enum
  column (profiling-gated). A memory benchmark guards the baseline.
- Across the **Worker** boundary, ship the interned `FacetWireData` + typed arrays as
  Transferables — no per-node dictionaries, no 50k re-allocated strings on the worker.

### Descriptor merge *(review §6, §10)*
Core/built-in wins metadata; provider values unioned; cardinality conflict upgrades to
`multi`; `providerIds` unioned. A node value **not** in a `closed` descriptor's domain does
**not** flip the domain to open — it is admitted (data not lost), surfaced as
`PresentDimensionValue.declared=false`, and an **undeclared-value warning** is raised. Keys
stay **namespaced** (`rust.visibility`).

### Catalog handshake
The catalog is the **sole** source of label/color/glyph; UI/CLI never hardcode. A
`filterable`/`groupable` descriptor missing a `label` is an **analysis error**. The Rust core
emits descriptors through the **same JSON `DimensionDescriptor` schema** as the TS analyzer.

### Canonical registry *(review §5)*
`canonicalKey` is **not** free-form. The core owns a registry of known canonical dimensions;
a provider *requests* an alias which the kernel validates:
```ts
export interface CanonicalDimensionClaim { providerKey: FacetKey; canonicalKey: CanonicalFacetKey; mappingVersion: number; }
```
Unvalidated claims stay namespaced (no accidental merge of semantically different concepts).

### Derivation
- **Filters** — one section per `filterable` `present()` descriptor; **sparse** selection
  *(review §4)*:
  ```ts
  export interface FacetSelection { mode: "all" | "include" | "exclude"; values: Set<string>; }
  // no map entry ⇒ all enabled; "all enabled except one" stores one value, not thousands.
  ```
  The scene gate honors `MissingPolicy.filter` (default `include`).
- **Group-by eligibility** *(review §14)*: a `groupable` dim is offered only if `DimensionStats`
  pass (`≥2` values, `≤200` shown, coverage `>20%`, largest bucket `<98%`); else under
  **Advanced** with `Other` aggregation. Grouping honors `MissingPolicy.group` (default
  `unclassified`).
- **Query** ([evaluate.ts](../../../lib/graph/query-language/evaluate.ts)) — `<key>:<value>`
  from the catalog; numeric/structural fields stay built-in.
- **Rules/config** — `NodeSelector.facets`; two-stage validation (§Phase D).
- **Visual** — facet value color/glyph from the descriptor; deterministic palette fallback.

---

## Grouping & collapse

### Namespaced group ids *(review §4-ids)*
`directory:src/server` · `package:@scope/x` · `facet:env:client` · `facet:rust.visibility:pub`
· `community:8f92c6`. Intent stored **per mode**: `Map<GroupingModeKey, CollapseIntent>`.
Community ids are **ephemeral** by default (reset on graph/filter-signature change); stable
membership ids are a later option.

### Compact grouping snapshot *(review §2)*
Worker-bound; **typed-array columnar**, not `Record<NodeOrdinal, GroupId[]>` (which is ~1.3M
arrays). Path is derived by walking `parentByGroup`:
```ts
export interface CompactGroupingSnapshot {
  modeKey: string;
  groupIds: string[];            // ordinal → id        (small: #groups, not #nodes)
  groupLabels: string[];
  parentByGroup: Int32Array;     // -1 = root
  depthByGroup: Uint16Array;
  boxKeyByGroup: string[];       // group → layout ClusterBox id (LOD/layout agreement)
  leafGroupByNode: Uint32Array;  // node ordinal → its leaf group ordinal
  roots: Uint32Array;
}
```
Transferred to the worker as typed arrays (durable workspace copies may be plain JSON).

### Multi-valued facet grouping *(review §5/4)*
`facets` is multi-valued but containment needs one group per node:
```ts
export type FacetGrouping =
  | { mode: "single" }                                  // single-cardinality → groupable
  | { mode: "primary"; choose: "first" | "priority" }   // pick one canonical value
  | { mode: "combination" }                             // value-set → one synthetic group
  | { mode: "disabled" };                               // filter/query only (default for multi)
```
`leafGroupByNode` always yields exactly one group, so the layout never duplicates a node.

### `Group by: None` keeps an internal hierarchy *(review §7)*
No visible containers, but Smart still builds a synthetic reduction hierarchy (connected
components → communities) so a 100k-node repo can't bypass the render budget. LOD runs on it.

### Three-layer collapse *(review §2, §3)*
```ts
export type CollapseIntent = Map<GroupId, "open" | "closed">;   // ONLY real user actions
```
Authoritative camera result is a **`LodCut`** (below), not a `lodOpen` set. Precedence
(highest first): explicit user closed → explicit user open → LOD cut → bootstrap closed →
default. `compose()` is pure and unit-tested.

**Transitions:** opening a child makes ancestors traversable; closing a parent preserves
descendant intent; **Reset** clears `intent` only. **"Expand all" is renamed** *(review §9)* —
the default toolbar action becomes **"Reveal detail"** (clears `closed` intent + enables LOD
to open within budget; writes no blanket `open`). A true exhaustive expand is a separate,
explicitly-labeled, warned command. Switching mode never reuses another mode's ids.

---

## Representation hierarchy & budgeted LOD *(review — the Nanite/Horizon core)*

`GroupingHierarchy` answers *"which nodes belong together?"*; a **`RepresentationHierarchy`**
answers *"at which levels can that group be rendered, and what does each level cost/hide?"*
They are **different abstractions**.

```ts
export interface RepresentationNode {
  id: number; groupId: GroupId;
  parent: number | null; children: number[];
  bounds: Rect;                                   // stable world-space region it owns
  nodeCost: number; edgeCost: number; labelCost: number; gpuByteCost: number;
  geometricError: number; structuralError: number;   // info hidden if this proxy is shown
  proxyKey: string;                               // cached aggregate scene for this level
}
export interface RepresentationHierarchy { roots: number[]; nodes: RepresentationNode[]; }
```

### The LOD result is a valid antichain cut
Every underlying node is represented **exactly once** — by an ancestor proxy or by descendants
— never both, never neither:
```ts
export interface LodCut {
  selectedRepresentations: Uint32Array;
  nodeCost: number; edgeCost: number; labelCost: number; gpuByteCost: number;
  generation: number;
}
```
An `open`-set view is derivable for back-compat, but the cut is authoritative.

### Error-per-cost refinement
From the bootstrap cut: cull outside viewport+prefetch; score visible reps; refine the
highest-value while budgets allow; evict offscreen refinements over budget.
```ts
priority = projectedError * visibilityWeight * interactionWeight * structuralImportance / refinementCost;
// projectedError ≈ projectedPixelArea * log2(1 + hiddenNodeCount) * (1 + relationshipEntropy) * (1 + boundaryEdgeRatio)  [starting heuristic]
```
Boost: selected / highlighted-path / search / problem-finding / viewport-center / recently
interacted. Suppress: generated / external / low-information leaves / mostly-offscreen.

### State machine + committed generations *(review §7, §8)*
```
auto closed              → opens when projected size > openThreshold
auto open & visible      → stays open through small zoom-out (deadband)
auto open & offscreen    → eviction-eligible below retainThreshold
over budget              → evict lowest-priority eligible reps (LRU)
```
Camera motion updates a **pending** cut; after debounce/hysteresis a *materially different*
cut is **committed**, incrementing `generation`. Only a committed `generation` triggers scene
rebuild / edge aggregation / local-layout load / renderer payload:
```ts
export interface LodRuntimeState { pendingCut: LodCut; committedCut: LodCut; generation: number; }
```
The LRU uses a pre-allocated **ring buffer / intrusive doubly-linked list** (not array
`shift()` or churning `Set`s) to avoid GC pauses on volatile pans.

### Edge LOD is mandatory
Node LOD without edge LOD is still a hairball. Map each original endpoint to its active
representative and aggregate:
```ts
representativeOf(originalNodeId, cut) → number
type AggregatedEdgeKey = `${srcRep}:${dstRep}:${edgeKind}`;
export interface LodEdge { source: number; target: number; kind: EdgeKind; count: number; exactCount: number; inferredCount: number; originalEdgeIds?: string[]; }
```
Independent budgets; under edge pressure: aggregate parallels → suppress proxy-internal edges
→ bundle cross-group → show only selected/path → density summaries.
```ts
export interface LodBudget { maxNodes: number; maxEdges: number; maxLabels: number; maxGpuBytes: number; maxLayoutWork: number; }
```
**Label LOD:** proxy label far → important child labels mid → full card labels near → selected
always.

### Global layout stability *(review — amends "layout untouched")*
Opening one directory must **not** move every other directory. Nested **stable local
coordinate spaces**: repository layout owns stable boxes for major groups; each group owns a
**cached local layout** in parent-space; child refinement changes only that box's contents.
A full global relayout happens **only** on a material change (filters / grouping mode /
direction / explicit request / contents overflow their region). The layout **algorithms**
stay unchanged; layout **orchestration** gains hierarchical local coordinate spaces + cached
per-group layouts.

### Ownership rule
```
Providers        own dimensions (catalog)
Grouping builder own the CompactGroupingSnapshot
Representation   builder owns the RepresentationHierarchy (proxies, costs, error)
User actions     own intent
Camera           owns only the pending/committed LodCut (+ eviction bookkeeping)
Collapse composer produces effectiveCollapsed (intent ⊕ bootstrap ⊕ cut)
Layout worker    consumes a snapshot + produces cached local layouts
Renderer         consumes the committed cut's proxies/edges/labels + geometry
```
No component writes another's source-of-truth state.

---

## Phase plan *(C1 split per review)*

- **A — Serializable dimension foundation.** `GraphNode.facets` (model strings); `DimensionCatalog`
  + descriptors (`MissingPolicy`, canonical-claim validation); provider `facetSchema` + merge
  (closed stays closed + `declared`); **dual-write** the four facets (detection unchanged);
  runtime `DimensionIndex` (ordinals, columnar, lazy). No UI change. *Unblocked once the
  model/runtime/transport split (above) is settled — it is.*
- **C0 — Collapse ownership, Directory only.** `CollapseIntent` + `bootstrapClosed` + a Directory
  `LodCut`; pure `compose()`; committed-generation notification; split `MissingPolicy` honored.
  Remove camera writes to intent. Preserve current Directory behavior.
- **B — Registry-driven filters.** Sparse `FacetSelection`; `visible()` from the index;
  `MissingPolicy.filter`; dynamic Sidebar + counts + eligibility; delete the hardcoded
  constants; workspace migration.
- **C1a — Generic semantic grouping.** `CompactGroupingSnapshot` (transferable); Directory /
  Package / Community / facet / synthetic-None; mode-keyed intent; mode-agnostic cut **on the
  existing collapse-shaped LOD** (no representation runtime yet).
- **C1b — Representation hierarchy + budgeted cut.** `RepresentationHierarchy`; antichain
  `LodCut`; projected-error scoring; **edge + label budgets**; prefetch ring; ring-buffer LRU;
  committed-cut generations.
- **C1c — Stable hierarchical layout orchestration.** Stable parent boxes; cached local
  layouts; local refinement; minimal global movement.
- **D — Query & rules on the registry.** Registry field lookup; `NodeSelector.facets`;
  two-stage config validation (`validation.unknownFacet` severity); legacy aliases; remove
  legacy named fields.
- **E — Per-language facets.** Extend `pack.yaml` + `tags.scm` + Rust `OutNode`/`build_graph`;
  start with stable semantics (Rust visibility/unsafe/async; Go package/exported; Python
  module/async/dunder; Java visibility/static/annotation).

---

## Testing strategy
Pure units for catalog merge, index, `compose`, hierarchies, `valuesOf`. Plus, per reviews:
- Dual-write **parity** (legacy ≡ facets) for every node (A–C).
- Catalog **handshake**: every filterable/groupable descriptor has a label; undeclared closed
  values get `declared:false` + a warning and the domain **stays closed**.
- Bootstrap-collapsed groups **can** be opened by the cut; camera never mutates intent; a group
  can't be open+closed at once; group state survives mode switch-and-return.
- Directory/facet ids can't collide; community intent resets on membership change.
- Multi-valued facet grouping yields exactly one group per node; missing nodes follow
  `MissingPolicy`.
- `LodCut` is a **valid antichain** (every node represented once; never proxy+children).
- **Edge LOD**: endpoints map to representatives; aggregated counts equal originals.
- Only a **committed generation** triggers a rebuild; pending churn does not.
- **Local refinement** changes only the refined box; sibling positions are byte-identical.
- `CompactGroupingSnapshot` / `FacetWireData` survive **structured-clone** round-trips;
  durable catalog survives **JSON** round-trip.
- **None** can't bypass the render budget; auto-open stays **bounded** after exploring many
  regions; panning a boundary doesn't thrash (hysteresis).
- Sparse `FacetSelection` ("all except one") stores one value.
- Workspace migration preserves old `collapsedClusters` + named filter sets.
- Connection-highlight anchors prune/remap after hierarchy/LOD changes.
- Layout cache signatures canonical regardless of `Map` insertion order.
- Memory benchmark within an agreed factor; golden: Phase A preserves exact facet values. The
  547 stay green.

## Migration & back-compat
Dual-write legacy fields + `facets` (A–C; remove end of D). Workspace
([schema.ts](../../../lib/workspace/schema.ts)): read old `enabled*`/`collapsedClusters`, map
to `FacetSelection`/`intentByMode`. Config keys + query strings alias to catalog keys. Worker
payloads use the transport codec; workspace stays JSON.

## Out of scope
Layout **algorithms** (`smart.ts` dagre/engine selection) and the Vello renderer math are
unchanged. Layout **orchestration** is in scope (local coordinate spaces, cached per-group
layouts). The **direction flip** is tracked separately (engine proven correct). No new
community-detection algorithm.

## Risks & open questions
- Canonical registry contents — defined incrementally; providers request, kernel validates.
- `projectedError` weighting — the formula is a starting heuristic; tune against real repos in
  C1b behind telemetry.
- Representation `proxyKey` cache invalidation across filter changes — key proxies by the
  filtered-graph signature.
- Rust↔TS descriptor parity — keep `DimensionDescriptor` JSON-flat for Phase E.
