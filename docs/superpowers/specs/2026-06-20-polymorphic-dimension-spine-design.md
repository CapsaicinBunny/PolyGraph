# Polymorphic Dimension Spine — Filters, Groups & Facets across all languages — Design

**Goal:** Re-architect the **filters** and **group** systems around a single,
language-agnostic **Dimension** model so they are *intelligent* (every control means
something for every language), *honest* (a control that's shown actually works),
*polymorphic* (each language provider contributes its own dimensions), and *fast but
safe*. Today the structural axes (`kind`, edge-kind, language, folder) work for all 26
languages, but the "intelligent" facets (`role`, `category`, `environment`, `runtime`)
are JS/TS-only and silently empty elsewhere — and the group/LOD/camera state machine is
structurally fragile (one `collapsedClusters` set with five writers; camera LOD wired to
Directory only).

**Status:** Multi-phase north-star. **Revision 2** — incorporates the architectural
review (serializable catalog vs runtime index; bootstrap-collapse is not user intent;
single intent map; mode-namespaced group ids; multi-valued facet grouping; serializable
grouping snapshot for the worker; None-mode internal hierarchy; bounded LOD eviction;
missing-facet semantics; descriptor merge rules; dual-write migration; two-stage config
validation; ordinal indexes; group-by eligibility). Detailed design here covers the
contracts shared by all phases; each phase gets its own implementation plan.

**Non-negotiables (carried from brainstorming, corrected by review):**
- Deep spine: generalize `role`/`category`/`environment`/`runtime` into a generic
  provider-contributed facet model; wire every consumer through it.
- Group modes (Directory / Package / Community / facet / None) are **peers**; LOD works
  for all (None via a synthetic internal hierarchy — §Grouping).
- Adaptive LOD defaults **on**, **perceptually monotonic around the viewport** but
  **budget-bounded** (offscreen auto-opens are evictable — §LOD).
- Collapse is **three-layered**: user `intent` (only), `bootstrapClosed` (derived safety),
  `lodOpen` (camera-derived). User intent wins; **bootstrap is not intent**.
- Data that crosses a serialization boundary is **plain JSON**; method-bearing objects are
  runtime-only and reconstructed deterministically.
- Fast but safe: ordinal indexes built lazily; phased delivery; the 547 existing tests
  stay green at every phase boundary.

---

## Background — current state

### The graph model
`GraphNode` ([lib/graph/types.ts:84](../../../lib/graph/types.ts)) carries a
language-neutral `kind` plus four **optional** facet fields that are JS/TS-only in
practice:

| Field | Produced where | All languages? |
| --- | --- | --- |
| `kind` | every provider | **yes** (universal spine) |
| `role` | [lib/analyzer/roles.ts](../../../lib/analyzer/roles.ts) | no — JS/TS only |
| `category` | [lib/analyzer/nodes.ts:64,72](../../../lib/analyzer/nodes.ts) | no — Rust core hardcodes `"feature"` ([analyzer-core/src/lib.rs:459,471](../../../analyzer-core/src/lib.rs)) |
| `environment` | [lib/analyzer/facets.ts:54](../../../lib/analyzer/facets.ts) | no — JS/TS only |
| `runtimes` | [lib/analyzer/facets.ts:98](../../../lib/analyzer/facets.ts) | no — JS/TS only |

### Production — two sites
1. **TS analyzer** (`roles.ts`, `facets.ts`, `nodes.ts`) — only place the four facets are detected.
2. **Rust core `build_graph()`** ([analyzer-core/src/lib.rs:439-476](../../../analyzer-core/src/lib.rs))
   — the single site where every pack's captures become `GraphNode`s; hardcodes
   `category:"feature"`, sets no other facet. The pack format has **no** facet mechanism.
   **This is the per-language extension point.**

Provider contract: [`LanguageProvider`](../../../lib/kernel/provider.ts) `{ id, extensions,
analyze() }` → `ProviderResult { nodes, edges, errors, unresolved? }`.

### Consumption — ~10 sites, each hardcoding the enums
Query language [evaluate.ts:148](../../../lib/graph/query-language/evaluate.ts) (switch on
field) · rules [selector.ts:10](../../../lib/rules/selector.ts) + config
[load.ts:22-63](../../../lib/config/load.ts) (hardcoded validation sets) · scene gate
[scene.ts:162](../../../lib/graph/scene.ts) (`SceneFilters` :36) · Sidebar
[Sidebar.tsx:60,356,500](../../../components/Sidebar.tsx) and Explorer
[Explorer.tsx:53,151](../../../components/Explorer.tsx) (`CATEGORIES`/`ENVIRONMENTS`/
`RUNTIMES`/`presentScope`) · visual [visual.ts:12-117](../../../lib/graph/visual.ts) ·
insights [insights.ts:142](../../../lib/graph/insights.ts). Pattern: each re-hardcodes the
value enums. **Polymorphism = one catalog both sides talk to.**

### The group / LOD / camera fragility (from the root-cause investigation)
- `collapsedClusters` — one `Set`, **five writers** (load-seed [Explorer.tsx:353](../../../components/Explorer.tsx);
  expand/collapse-all `:324,335`; manual drill `:436`; camera `onCut` `:722`; workspace
  restore `:388`); the camera writer overwrites the whole set.
- `adaptiveLod` — dual-owner; `useState(true)` dead; effective default `seed!==null`, so
  off under 2000 cards.
- Camera cut wired to Directory only ([VelloGraphCanvas.tsx:655,661](../../../components/VelloGraphCanvas.tsx)).
- Smart layout derives the directory cluster tree **internally** from node ids and branches
  on Directory/Community/None ([lib/layout/smart.ts](../../../lib/layout/smart.ts)). The
  layout **algorithms** are correct and stay; but the grouping **input contract** must
  change to admit arbitrary grouping (see §Grouping snapshot).
- Layout math + Vello renderer are **provably correct** for direction
  ([vello-renderer/src/lib.rs:269](../../../vello-renderer/src/lib.rs) — affine, no
  transpose); the perceived flip is out of scope here.

---

## North-star architecture

### The Dimension model
A **Dimension** is any axis you can filter, group, query, or style by — unified under one
catalog:
- **Structural dimensions** — universal, derived, never copied: `kind`, `language`,
  `folder`, `package`.
- **Facet dimensions** — provider-contributed, stored on the node: `role`, `category`,
  `env`, `runtime` now; per-language later.

### `GraphNode.facets` + **dual-write** migration *(review §11)*
Add a generic field; keep `kind` first-class (load-bearing for layout/size/glyph, truly
universal — **not** demoted):

```ts
export interface GraphNode {
  // …id, kind, label, filePath, line, parentFile…
  facets?: Record<FacetKey, string[]>;   // always arrays (single-valued holds one entry)
}
```

Because nodes cross Rust → sidecar → client → worker → workspace as **plain JSON**, the
migration emits **both** the legacy field and the facet — *not* a derived getter (getters
don't survive serialization):

```ts
{ environment: "client", facets: { env: ["client"] } }   // dual write during A–C
```

Legacy named fields are removed only after every consumer reads `facets` (end of Phase D).

### Serializable catalog vs. runtime index *(review §1, §13)*
The catalog travels with the analysis as JSON; the index is rebuilt at runtime and never
serialized.

```ts
// JSON-safe — travels with AnalyzeResult, sidecar→client, into workspaces.
export interface DimensionCatalog {
  descriptors: DimensionDescriptor[];
}

export interface DimensionDescriptor {
  key: FacetKey;                       // "role", "env", "rust.visibility", "directory"
  label: string;
  dimension: "structural" | "facet";
  cardinality: "single" | "multi";
  domain: "closed" | "open";           // closed = known value set; open = derive from data
  values: DimensionValue[];            // {value,label,color?,glyph?} — may be [] for open
  providerIds: string[];               // merged contributors (NOT one)
  canonicalKey?: string;               // e.g. rust.visibility → "visibility"
  filterable: boolean;
  groupable: boolean;
  missing: "include" | "exclude" | "unclassified";   // §9
  grouping: FacetGrouping;             // §5
}

// Runtime-only — reconstructed deterministically from (graph + catalog). Holds Maps/typed
// arrays; never crosses a serialization boundary.
export interface DimensionIndex {
  descriptor(key: FacetKey): DimensionDescriptor | undefined;
  present(key: FacetKey): ReadonlySet<string>;          // replaces presentScope
  valuesOf(node: GraphNode, key: FacetKey): readonly string[];   // structural via adapter
  nodesWith(key: FacetKey, value: string): readonly number[];    // node ordinals
}
```

`AnalyzeResult` gains `dimensions: DimensionCatalog`. The client, CLI, and rule engine each
build the **same** `DimensionIndex` from `(graph, catalog)` — deterministic, no shared
mutable runtime object.

### Index representation *(review §13)*
- Assign each node a stable **ordinal** once; postings are `Uint32Array` of ordinals, not
  repeated string ids.
- Build **lazily**, only for dimensions that are `present` AND (`filterable` or `groupable`)
  AND actually requested.
- Small **closed** domains → bitsets; **open** high-cardinality domains → sorted ordinal
  arrays.

### Provider contract & descriptor merge *(review §10)*
```ts
export interface ProviderResult {
  // …nodes, edges, errors, unresolved?…
  facetSchema?: DimensionDescriptor[];   // descriptors this provider can emit
}
```
Kernel merge rules (deterministic):
- **Core/built-in descriptor wins metadata** (label/color/cardinality default).
- **Provider values are unioned** into the domain.
- **Cardinality conflict upgrades to `multi`.**
- **Unknown value against a `closed` domain → an analysis warning** (surfaced in Problems),
  value still admitted as `open`-fallback so nothing is silently dropped.
- Provider-specific keys stay **namespaced** (`rust.visibility`); a provider may set
  `canonicalKey` to opt a key into a shared concept.

### Everything derives from the catalog/index
- **Filters** (Sidebar/Explorer): one section per `filterable` descriptor that is
  `present()`; chips from `values` (or derived from `present()` for open domains) with
  counts. Delete `CATEGORIES`/`ENVIRONMENTS`/`RUNTIMES`/`ALL_*`/`presentScope`. State →
  `enabledFacets: Map<FacetKey, Set<string>>`.
- **Missing-facet semantics** *(review §9)*: the gate honors the descriptor's `missing`:
  `include` (today's behavior — a node without the facet passes), `exclude`, or
  `unclassified` (matches a synthetic "—" bucket the UI can show). Default `include` for
  optional facets; grouping defaults to `unclassified`.
- **Scene gate** ([scene.ts:162](../../../lib/graph/scene.ts)): `visible()` iterates enabled
  dimensions via `index.valuesOf(n,key)` + `missing` policy. `SceneFilters` →
  `{ enabledFacets, enabledFolders, enabledLanguages, enabledEdgeKinds, showExternal }`
  (folder/language keep dedicated sets — they drive the separate FiltersPanel; edge-kind is
  an *edge* dimension; the split is storage-only, `visible()` reads all uniformly).
- **Group-by eligibility** *(review §14)*: a `groupable` dimension is offered only if its
  `DimensionStats` pass — `valueCount ≥ 2`, `≤ 200` values shown by default,
  `coverageRatio > 0.2`, `largestBucketRatio < 0.98`. Higher-cardinality dimensions appear
  under an **Advanced** selector with automatic `Other` aggregation.
- **Query language** ([evaluate.ts:148](../../../lib/graph/query-language/evaluate.ts)):
  `<key>:<value>` resolves from the catalog; numeric/structural fields (`incoming`,
  `outgoing`, `cycle`, `depends-on`, `path`) stay built-in.
- **Rules/config**: `NodeSelector.facets?: Record<FacetKey,string[]>`; **two-stage
  validation** (§Phase D). Legacy keys alias to facets.
- **Visual** ([visual.ts](../../../lib/graph/visual.ts)): facet value color/glyph from the
  descriptor, deterministic palette fallback. `kind` styling unchanged.

---

## Grouping & collapse model

### Namespaced group ids *(review §4)*
Group ids are prefixed by mode so directory paths, facet values, packages, and community
ids can't collide:
```
directory:src/server      package:@polygraph/core
facet:env:client          facet:rust.visibility:pub
community:8f92c6
```
Collapse intent is stored **per grouping mode**: `Map<GroupingModeKey, CollapseIntent>` —
so collapsing `drivers/` in Directory mode, switching to Community, and returning preserves
the directory state.

**Community id stability:** community numbering is unstable across filter/node changes. We
either (a) detect communities **once on the base graph** and key intent by stable
membership ids, or (b) treat community intent as **ephemeral** and reset it when the
graph/filter signature changes. Default: **(b) ephemeral**, with (a) as a later refinement.
Never persist `community:4` based on detection order alone.

### Serializable grouping snapshot for the worker *(review §6)*
Today Smart derives the cluster tree from node ids internally. To support arbitrary
grouping while keeping the layout **algorithms** untouched, the grouping **input** becomes a
JSON-safe snapshot the worker consumes — it no longer knows about directories, communities,
or facets:

```ts
type GroupId = string;        // mode-namespaced
type NodeOrdinal = number;

interface GroupRecord {
  id: GroupId;
  parentId: GroupId | null;
  label: string;
  depth: number;
  directNodeIds: NodeOrdinal[];   // DIRECT membership only (transitive derived via tree)
}

interface GroupingSnapshot {
  modeKey: string;
  roots: GroupId[];
  groups: GroupRecord[];
  pathByNode: Record<NodeOrdinal, GroupId[]>;   // one canonical containment path per node
  boxKeyByGroup: Record<GroupId, string>;       // group → the ClusterBox id layout emits
}
```
Direct membership + tree derivation avoids the quadratic blow-up of storing every
descendant under every ancestor. The LOD cut and the layout agree via `boxKeyByGroup`.

### Multi-valued facet grouping *(review §5)*
`facets` is multi-valued, but ordinary containment needs **one** group per node. So:
- `cardinality:"single"` facets are **groupable** automatically.
- Multi-valued facets are **filterable/queryable** by default but **not groupable** unless
  they opt into a strategy:

```ts
type FacetGrouping =
  | { mode: "single" }                                  // single-cardinality
  | { mode: "primary"; choose: "first" | "priority" }   // pick one canonical value
  | { mode: "combination" }                             // value-set groups: "node+bun"
  | { mode: "disabled" };                               // filter/query only
```
`pathByNode` always yields one path; `combination` maps a node's value-set to a single
synthetic group id.

### `Group by: None` keeps an internal hierarchy *(review §7)*
None means **no visible containers**, not "no safety hierarchy." The renderer draws no
boxes, but Smart still builds a **synthetic** reduction hierarchy (connected components →
communities) so a 100k-node repo can't bypass the render budget by selecting None. LOD
operates on the synthetic hierarchy; the UI shows containers: off.

### Three-layer collapse *(review §2, §3)*
The bootstrap safety seed is **derived state, not user intent** — otherwise zoom could never
auto-open it. One intent map (can't self-contradict) + two derived sets:

```ts
type CollapseIntent = Map<GroupId, "open" | "closed">;   // ONLY real user actions

interface ViewState {                 // serializable (workspace)
  groupingMode: string;
  intentByMode: Record<string, [GroupId, "open" | "closed"][]>;  // JSON form of the Map
  lodEnabled: boolean;
}

interface DerivedViewState {          // runtime-only
  bootstrapClosed: Set<GroupId>;      // initial safety reduction (size-based)
  lodOpen: Set<GroupId>;              // camera-derived refinement
  effectiveCollapsed: Set<GroupId>;   // composed
}
```

**Precedence (highest first):**
```
1. explicit user "closed"
2. explicit user "open"
3. LOD open
4. bootstrap closed
5. default hierarchy state
```
`compose()` is pure and unit-tested. Removing an intent entry returns the group to
automatic behavior (`intent.delete(id)`).

**Hierarchy transitions (defined now):**
- Opening a child makes all ancestors traversable (path to it is open).
- Closing a parent preserves descendant intent for later reopening.
- **Reset** clears `intent` only — not bootstrap/LOD automatic state.
- **Expand-all** enables LOD and clears `closed` intent so detail opens within budget; it
  does **not** write blanket `open` intent (which would pin every group and exhaust the
  card budget on huge repos). **Collapse-all** writes `closed` intent on the top-level
  groups. So both are expressible as ordinary intent edits — no special collapse channel.
- Switching grouping mode never reuses another mode's ids (namespacing guarantees this).

### Camera LOD: mode-agnostic + budget-bounded eviction *(review §8)*
`computeLodOpen(hierarchy, boxes, camera, viewport, budget)` is **perceptually monotonic
around the active viewport** but **bounded**:
- User-`open` groups never auto-close.
- Visible auto-open groups stay open while relevant.
- **Offscreen** auto-open groups are **evictable** when the global card budget is exceeded
  (LRU by `lastVisibleAt`); zooming out alone does not close the current region.

```ts
interface AutoOpenEntry { groupId: GroupId; lastVisibleAt: number; lastOpenedAt: number; }
```
The camera writes **only** `lodOpen`/eviction bookkeeping (a ref) — never `intent` or the
layout-driving collapse — so it can never clobber user intent.

### Camera/fit decoupling & toggle independence
`fitSignature` keys on *intent* (graph/level/filters/mode/`intent`/expand) but **not**
`lodOpen`, so LOD refinement never re-fits. Changing `groupBy` recomputes the hierarchy and
re-derives `lodOpen` for the new mode and touches **nothing else** (never `showExternal`,
`expanded`, `lodEnabled`) — asserted by a regression test.

### Ownership rule
```
Analyzer/providers  own dimensions (catalog)
Grouping builder    owns the hierarchy/snapshot
User actions        own intent
Camera              owns only derived LOD observations (+ eviction)
Collapse composer   produces effectiveCollapsed
Layout worker       consumes a GroupingSnapshot
Renderer            consumes boxes + geometry
```
No component writes another component's source-of-truth state.

---

## Phase plan *(reordered per review)*

The riskiest piece — collapse-state ownership — is isolated to Directory mode **before**
dynamic grouping multiplies its complexity.

### Phase A — Serializable dimension foundation
`GraphNode.facets`; `DimensionCatalog` + `DimensionDescriptor`; provider `facetSchema` +
merge rules; **dual-write** the four facets (detection unchanged); runtime `DimensionIndex`
(ordinals, lazy). No UI change. Tests: catalog/index round-trip + merge; golden facet
parity; 547 green.

### Phase C0 — Collapse ownership, **Directory only**
Replace `collapsedClusters` with `CollapseIntent` + `bootstrapClosed` + `lodOpen`; remove
camera writes to intent; pure `compose()`; preserve current Directory behavior. Isolates the
state-machine rewrite. Tests: precedence; bootstrap is auto-openable by zoom; camera never
mutates intent; can't be open+closed at once.

### Phase B — Registry-driven filters
Generic `enabledFacets`; `visible()` from the index; missing-value semantics; dynamic
Sidebar with counts + eligibility; delete the hardcoded constants; workspace migration.
Tests: present-only filters; non-JS project shows non-empty filters; missing policy.

### Phase C1 — Generic grouping + mode-agnostic LOD
`GroupingSnapshot` into the worker; Directory/Package/Community/facet/**synthetic-None**
hierarchies; mode-keyed intent; mode-agnostic cut; **budgeted auto-open eviction**;
multi-valued facet grouping policy. Tests: snapshot JSON round-trip; mode-switch preserves
state; None can't bypass budget; bounded auto-open; Smart still selects per-cluster engines
from an injected snapshot.

### Phase D — Query & rules on the registry
Registry-backed field lookup in `evaluate.ts`; `NodeSelector.facets`; **two-stage config
validation** (pre-analysis: syntax/types/known built-in keys; post-analysis: dynamic
dimension existence/domains/provider availability) with configurable severity
(`validation.unknownFacet: warning`); legacy aliases. Remove legacy named fields. Tests:
dynamic facet queries; legacy `.polygraph.yml` still validates/matches.

### Phase E — Per-language facets *(incremental)*
Extend `pack.yaml` + `tags.scm` captures + Rust `OutNode`/`build_graph()`; pack contributes
a `facetSchema`. Start with stable, non-name-inferred semantics:
```
Rust    visibility, module kind, unsafe, async
Go      package, exported, receiver kind
Python  module, async, decorator category, dunder
Java    visibility, static, abstract, annotation category
```

---

## Testing strategy
Pure units for every new module (catalog merge, index, `compose`, `computeLodOpen`,
hierarchies, `valuesOf`), plus — per review:
- Bootstrap-collapsed groups **can** be opened by zoom.
- Camera updates **never** mutate user intent.
- A group can't be explicitly open and closed simultaneously.
- Group state **survives** switching away and back to a mode.
- Directory and facet ids **cannot collide**.
- Community intent **resets/remaps** when membership changes.
- Multi-valued facet grouping follows its declared policy.
- Missing-facet nodes follow descriptor policy.
- `DimensionCatalog` and `GroupingSnapshot` survive **JSON round-trips**.
- **None** mode cannot bypass the large-graph render budget.
- Auto-open detail stays **bounded** after exploring several regions.
- Workspace migration preserves old `collapsedClusters` + named filter sets.
- Connection-highlight anchors are **pruned/remapped** after hierarchy/LOD changes.
- Smart still selects per-cluster engines after receiving an external snapshot.
- Layout cache signatures are **canonical regardless of `Map` insertion order**.
- Golden: Phase A preserves exact facet values (no detection drift). The 547 stay green.

## Migration & back-compat
- **GraphNode:** dual-write legacy fields + `facets` through Phases A–C; remove named fields
  end of Phase D.
- **Workspace** ([lib/workspace/schema.ts](../../../lib/workspace/schema.ts)): read old
  `enabled*`/`collapsedClusters`, map to `enabledFacets`/`intentByMode` (Directory).
- **Config:** `kinds`/`roles`/`environments`/`categories` keys map onto `facets`.
- **Query strings/presets:** `role:`/`env:`/`category:` alias to catalog keys.

## Out of scope
- **Layout algorithms** (`lib/layout/smart.ts` dagre/engine selection) and the **Vello
  renderer** — untouched. (The grouping **input contract** changes to a `GroupingSnapshot`;
  the algorithms that consume it do not.)
- **Direction flip** — engine + renderer proven correct; tracked separately (needs live
  repro).
- New community-detection algorithms; edge routing/bundling.

## Risks & open questions
- **Canonical vs. namespaced facet keys:** default namespaced + opt-in `canonicalKey`.
  *(Confirm concrete canonical set in Phase E.)*
- **Open high-cardinality dimensions:** `values:[]` + derive chips from `present()`;
  group-by gated by eligibility + `Other` aggregation.
- **Rust↔TS descriptor parity:** keep `DimensionDescriptor` JSON-flat so the Rust core can
  emit it in Phase E.
- **Community stability:** ephemeral by default; stable-membership ids are a later option.
