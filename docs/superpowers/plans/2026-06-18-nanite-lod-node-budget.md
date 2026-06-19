# Node-Aware LOD Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Smart layout engaged on large projects by bounding the layout input to a size Smart lays out in <2s — counting actual layout *nodes* (files + their symbols when expanded), not just file cards — so Smart never times out, never falls back to grid, and the adaptive LOD cut never self-suspends.

**Architecture:** The vicious cycle is: expand-all expands all files → un-absorbed files emit all their symbols → layout input balloons to ~29k nodes → Smart (~40s at 29k, measured) blows past the 2000ms worker timeout → synchronous **grid** fallback (clusters=`[]`) → `recomputeCut` self-suspends on `scene.clusters.length===0` → the view is never trimmed → Smart keeps timing out → stuck in grid. The root defect is that both budgeting mechanisms (`autoCollapseDirs` seed and `computeCut`) count **file cards only and ignore symbols**, so they fail to bound the node count when files are expanded. Fix: teach both to budget on a caller-supplied per-file *node cost* (`1 + visibleSymbols`). With the input always bounded under Smart's interactive budget, Smart always finishes → clusters always present → the existing camera-driven, monotonic cut keeps working exactly as designed (open detail where you look). This deliberately *prevents* the grid fallback rather than recovering from it, so the hardest parts (clusters-independent geometry, non-monotonic re-collapse) are not needed.

**Tech Stack:** TypeScript, Bun test, React (Next.js), pure functions in `lib/graph/`, wiring in `components/`.

**Non-goals (deferred):** Two-stage timeout / provisional-grid-then-refine (responsiveness polish); clusters-independent cut geometry and cut recovery (only needed if a fallback still occurs — bounding makes it not occur for the default Directory grouping). `groupBy:"none"` legitimately yields no clusters (no containers by design) and keeps the low layout cap; LOD is inherently limited there and that is out of scope.

---

## Measured facts that anchor the budget

`smartLayout`, directory-grouped, dense (~2.8 edges/node): 2k nodes=765ms, 5k=2674ms, 10k=7751ms, 29k=40331ms, 50k=81378ms (super-linear ~O(n^1.45)). Only ≤~3k finishes under 2s. **Target node budget ≈ 2500** (≈1s, safe margin under the 2000ms timeout). Directory grouping produces clusters at every scale (1824 at 29k), confirming the telemetry `clusters=0` was the grid fallback, not Smart.

---

## File Structure

- `lib/graph/lod-cut.ts` — **modify.** Add an optional per-file `nodeCost` fn + `nodeBudget` to `CutOptions`; budget the walk on node cost in addition to the existing `maxCards`. Default args preserve exact current behavior.
- `lib/graph/lod-cut.test.ts` — **modify.** Add tests: default behavior unchanged; symbol-heavy files force earlier collapse under `nodeBudget`.
- `lib/graph/auto-collapse.ts` — **modify.** Add an optional per-file `nodeCost` fn; pick the collapse depth on summed node cost instead of file count. Default preserves current behavior.
- `lib/graph/auto-collapse.test.ts` — **modify** (create the `describe` if absent). Add tests: default unchanged; symbol-weighted files pick a shallower (more-collapsed) depth.
- `components/Explorer.tsx` — **modify.** Build a memoized `symbolCount: Map<fileId, number>` from the base graph; pass node-aware budgeting into the two `autoCollapseDirs` call sites (scan seed + expand-all) so expand-all stays bounded; pass `symbolCount` + `expanded` down to `VelloGraphCanvas`.
- `components/VelloGraphCanvas.tsx` — **modify.** Accept `symbolCount` + `expanded` props; add `NODE_BUDGET`; build a `nodeCost` fn and pass `nodeCost`/`nodeBudget` into the `computeCut`/`computeCutTraced` `cutOpts`.

---

## Task 1: Node-cost budgeting in `computeCut`

**Files:**
- Modify: `lib/graph/lod-cut.ts` (`CutOptions` ~22-33; `cutCore` ~70-149)
- Test: `lib/graph/lod-cut.test.ts`

Design: `cutCore` currently tracks `cards` (1 per collapsed aggregate + 1 per opened file) and collapses a dir when `cards + node.files.length > maxCards`. Add a parallel `nodes` tally where an opened file costs `nodeCost(fileId)` (default 1) and collapse also triggers when the projected node total would exceed `nodeBudget` (default `Infinity`). A collapsed dir is one aggregate node (cost 1, same as its card).

- [ ] **Step 1: Write the failing tests**

Add to `lib/graph/lod-cut.test.ts` (reuse the file's existing `DirNode`/`Box` helpers; if it builds trees inline, mirror that style):

```ts
import { describe, expect, test } from "bun:test";
import { computeCut } from "./lod-cut";
import type { DirNode } from "./hierarchy";
import type { Box } from "./lod-screen";

// Minimal tree: root → two dirs "a","b", each with N files, all on-screen and large.
function tree(filesA: string[], filesB: string[]): DirNode {
  const mk = (path: string, files: string[]): DirNode => ({
    path, name: path, depth: 1, children: [], files, totalFiles: files.length,
  });
  return {
    path: "", name: "", depth: 0, totalFiles: filesA.length + filesB.length,
    files: [], children: [mk("a", filesA), mk("b", filesB)],
  };
}
// Boxes big enough to open (height >> openPx) and inside the viewport.
function boxes(paths: string[]): Map<string, Box> {
  const m = new Map<string, Box>();
  for (const p of paths) m.set(p, { x: 0, y: 0, w: 100, h: 100000 });
  return m;
}
const CAM = { x: 0, y: 0, scale: 1 };
const VP = { w: 10000, h: 10000 };

describe("computeCut node budget", () => {
  test("nodeCost defaults to 1 → node budget never collapses when maxCards is high", () => {
    const t = tree(["a/1", "a/2"], ["b/1", "b/2"]);
    const cut = computeCut(t, boxes(["a", "b"]), CAM, VP, { openPx: 240, maxCards: 1000 });
    expect(cut.size).toBe(0); // both dirs open; nothing collapsed
  });

  test("symbol-heavy files exceed nodeBudget → dirs collapse instead of opening", () => {
    const t = tree(["a/1", "a/2"], ["b/1", "b/2"]);
    // Each file carries 100 symbols: opening either dir costs 2 + 200 = 202 nodes.
    const nodeCost = () => 101;
    const cut = computeCut(t, boxes(["a", "b"]), CAM, VP, {
      openPx: 240, maxCards: 1000, nodeBudget: 150, nodeCost,
    });
    // First dir (a) costs 2×101=202 > 150 budget → collapse; b likewise.
    expect(cut.has("a")).toBe(true);
    expect(cut.has("b")).toBe(true);
  });

  test("budget opens what fits, collapses the overflow", () => {
    const t = tree(["a/1"], ["b/1", "b/2", "b/3"]);
    // nodeCost 1 each. nodeBudget 2: 'a' (1 file) opens (nodes=1); 'b' (3 files) would
    // push nodes to 4 > 2 → 'b' collapses (its aggregate costs 1 → nodes=2).
    const cut = computeCut(t, boxes(["a", "b"]), CAM, VP, {
      openPx: 240, maxCards: 1000, nodeBudget: 2,
    });
    expect(cut.has("a")).toBe(false);
    expect(cut.has("b")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/graph/lod-cut.test.ts`
Expected: the two new budget tests fail (`nodeBudget`/`nodeCost` not in `CutOptions`, no budget effect).

- [ ] **Step 3: Implement node-cost budgeting**

In `lib/graph/lod-cut.ts`, extend `CutOptions`:

```ts
export interface CutOptions {
  openPx: number;
  maxCards: number;
  hysteresis?: number;
  prevCut?: Set<string>;
  margin?: number;
  /** Layout-node cost of an opened file (1 + its visible symbols). Default 1. */
  nodeCost?: (fileId: string) => number;
  /** Cap on estimated layout NODES (files + symbols + aggregates). Default Infinity. */
  nodeBudget?: number;
}
```

In `cutCore`, destructure the new options and track node cost alongside `cards`:

```ts
  const {
    openPx, maxCards, hysteresis = 0.8, prevCut, margin = 0,
    nodeCost = () => 1, nodeBudget = Infinity,
  } = opts;
  const collapsed = new Set<string>();
  let cards = 0;
  let nodes = 0;
  // ...dirsEvaluated/dirsOnScreen unchanged...

  const costOf = (node: DirNode) => {
    let c = 0;
    for (const f of node.files) c += nodeCost(f);
    return c;
  };
```

In `record`, a collapse adds one aggregate node:

```ts
    if (decision === "collapse") {
      collapsed.add(node.path);
      cards += 1;
      nodes += 1;
    }
```

In `visit`, gate opening on BOTH budgets and tally node cost on open:

```ts
    if (cards + node.files.length > maxCards || nodes + costOf(node) > nodeBudget) {
      return record(node, true, sh, threshold, "collapse", "budget");
    }
    // Open: direct files render individually; recurse into child dirs.
    record(node, true, sh, threshold, "open", "opened");
    cards += node.files.length;
    nodes += costOf(node);
    for (const child of node.children) {
      if (cards >= maxCards || nodes >= nodeBudget) {
        const cb = boxes.get(child.path);
        record(child, !!cb, cb ? screenHeight(cb, cam.scale) : 0, openPx, "collapse", "budget");
        continue;
      }
      visit(child);
    }
```

Apply the same `cards >= maxCards || nodes >= nodeBudget` guard in the root loop (replace the two `if (cards >= maxCards)` budget checks at the root and child loops). Keep `cards` accounting exactly as before so the default path is byte-for-byte equivalent.

- [ ] **Step 4: Run to verify pass**

Run: `bun test lib/graph/lod-cut.test.ts`
Expected: all tests pass (new + existing — the existing ones use no `nodeCost`/`nodeBudget`, so defaults keep them green).

- [ ] **Step 5: Commit**

```bash
git add lib/graph/lod-cut.ts lib/graph/lod-cut.test.ts
git commit -m "feat(lod): node-cost budget in computeCut (symbol-aware, default-preserving)"
```

---

## Task 2: Node-cost budgeting in `autoCollapseDirs`

**Files:**
- Modify: `lib/graph/auto-collapse.ts` (~29-73)
- Test: `lib/graph/auto-collapse.test.ts`

Design: `rendered(d)` currently = `dirsAtDepth(d) + (totalFiles - filesDeepEnough(d))` (un-absorbed file *count*). Make it sum the per-file `nodeCost` over un-absorbed files instead of counting them, and compare against the budget. Default `nodeCost = () => 1` reproduces today's behavior. Monotonicity is preserved: deeper `d` un-absorbs more (heavier) files, so `rendered(d)` still increases with `d`.

- [ ] **Step 1: Write the failing tests**

In `lib/graph/auto-collapse.test.ts` (create the file if it doesn't exist):

```ts
import { describe, expect, test } from "bun:test";
import { autoCollapseDirs } from "./auto-collapse";
import type { GraphModel } from "./types";

// 30 files across 3 top dirs, each "d{k}/f{i}.ts". Minimal GraphModel.
function fileGraph(): GraphModel {
  const nodes = [];
  for (let d = 0; d < 3; d++)
    for (let i = 0; i < 10; i++)
      nodes.push({ id: `d${d}/f${i}.ts`, kind: "file", label: `f${i}.ts`, filePath: `d${d}/f${i}.ts`, parentFile: `d${d}/f${i}.ts` } as never);
  return { nodes, edges: [] } as unknown as GraphModel;
}

describe("autoCollapseDirs node cost", () => {
  test("default (cost 1) is unchanged: 30 files, budget 5 → collapse to depth 1 (3 dirs)", () => {
    const r = autoCollapseDirs(fileGraph(), 5);
    expect(r).not.toBeNull();
    expect(r!.depth).toBe(1);
    expect(r!.renderedEstimate).toBe(3); // 3 aggregate cards
  });

  test("symbol-weighted files collapse even when file COUNT fits the budget", () => {
    // 30 files, budget 50. By count, all 30 fit (no collapse). But each file carries
    // 10 symbols → un-absorbed cost = 30×11 = 330 ≫ 50, so it must collapse.
    const r = autoCollapseDirs(fileGraph(), 50, () => 11);
    expect(r).not.toBeNull();
    expect(r!.depth).toBe(1); // collapse top dirs: 3 aggregates = cost 3 ≤ 50
  });

  test("returns null only when node cost (not just count) fits", () => {
    // 30 files cost 1 each = 30 ≤ budget 100 → already fits, no collapse.
    expect(autoCollapseDirs(fileGraph(), 100)).toBeNull();
    // Same files at cost 11 each = 330 > 100 → must collapse.
    expect(autoCollapseDirs(fileGraph(), 100, () => 11)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/graph/auto-collapse.test.ts`
Expected: the symbol-weighted tests fail (3rd arg ignored; cost-based collapse never triggers).

- [ ] **Step 3: Implement node-cost budgeting**

In `lib/graph/auto-collapse.ts`, add the optional param and switch counts to summed cost:

```ts
export function autoCollapseDirs(
  graph: GraphModel,
  maxCards: number,
  nodeCost: (fileId: string) => number = () => 1,
): AutoCollapse | null {
  const files = graph.nodes.filter((n) => n.kind === "file");
  const totalCost = files.reduce((s, n) => s + nodeCost(n.id), 0);
  if (totalCost <= maxCards) return null;

  const dirsAtDepth = new Map<number, Set<string>>();
  // costDeepEnough[d] = summed nodeCost of files whose dir depth is >= d
  // (the files a depth-d collapse absorbs into aggregates).
  const costDeepEnough = new Map<number, number>();
  let maxDepth = 0;

  for (const n of files) {
    const prefixes = dirPrefixes(n);
    const cost = nodeCost(n.id);
    maxDepth = Math.max(maxDepth, prefixes.length);
    prefixes.forEach((path, i) => {
      const d = i + 1;
      let set = dirsAtDepth.get(d);
      if (!set) { set = new Set(); dirsAtDepth.set(d, set); }
      set.add(path);
      costDeepEnough.set(d, (costDeepEnough.get(d) ?? 0) + cost);
    });
  }

  const rendered = (d: number): number => {
    const dirs = dirsAtDepth.get(d)?.size ?? 0;
    const absorbedCost = costDeepEnough.get(d) ?? 0;
    return dirs + (totalCost - absorbedCost);
  };

  let chosen = 0;
  for (let d = 1; d <= maxDepth; d++) {
    if (rendered(d) <= maxCards) chosen = d;
    else break;
  }
  if (chosen === 0) chosen = 1;

  return {
    depth: chosen,
    collapsed: dirsAtDepth.get(chosen) ?? new Set(),
    renderedEstimate: rendered(chosen),
  };
}
```

Note: a file directly in the root (no `dirPrefixes`) contributes to `totalCost` but to no depth bucket — it stays un-absorbed at every depth, exactly as today (it was counted in `total` but never in `filesDeepEnough`). Behavior preserved.

- [ ] **Step 4: Run to verify pass**

Run: `bun test lib/graph/auto-collapse.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/graph/auto-collapse.ts lib/graph/auto-collapse.test.ts
git commit -m "feat(lod): node-cost budget in autoCollapseDirs (symbol-aware, default-preserving)"
```

---

## Task 3: Wire symbol-aware budgeting through the components

**Files:**
- Modify: `components/Explorer.tsx` (`AUTO_COLLAPSE_MAX_CARDS` ~56; symbol map near the `parentFile` map ~274-277; `handleToggleExpandAll` ~286-296; scan seed ~310-312; the `<VelloGraphCanvas .../>` render)
- Modify: `components/VelloGraphCanvas.tsx` (props/interface ~40-56 + ~140-160; `LOD_MAX_CARDS` ~29; the `lod` ref ~236-247; `cutOpts` ~470)

Design: introduce one budget constant `LOD_NODE_BUDGET = 2500`. Build `symbolCount: Map<fileId, number>` once in `Explorer`. Define the node cost as `1 + (expanded.has(file) ? symbolCount : 0)` — at File level with nothing expanded this is 1 (today's behavior); under expand-all it's `1 + symbols`. Feed it to both `autoCollapseDirs` call sites and to the cut.

- [ ] **Step 1: Add the symbol-count map in Explorer**

In `components/Explorer.tsx`, near the existing `parentFile` map (~274-277), add:

```ts
  const symbolCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of baseGraph?.nodes ?? []) {
      if (n.kind !== "file") m.set(n.parentFile, (m.get(n.parentFile) ?? 0) + 1);
    }
    return m;
  }, [baseGraph]);
```

- [ ] **Step 2: Make expand-all bound on node cost**

Replace the `handleToggleExpandAll` body (~286-296) so the reseed accounts for symbols when expanding (use the larger node budget, and cost = 1 + symbols since every file is expanded):

```ts
  const handleToggleExpandAll = useCallback(() => {
    const nextExpanded = allExpanded ? new Set<string>() : new Set(fileIds);
    setExpanded(nextExpanded);
    // Reseed the collapsed cut. When expanding everything, each un-absorbed file also
    // emits its symbols, so budget on node cost (1 + symbols) to keep the layout input
    // small enough for Smart to lay out (else it times out and falls back to grid).
    const cost = (id: string) => 1 + (allExpanded ? 0 : (symbolCount.get(id) ?? 0));
    setCollapsedClusters(
      baseGraph
        ? (autoCollapseDirs(baseGraph, LOD_NODE_BUDGET, cost)?.collapsed ?? new Set())
        : new Set(),
    );
  }, [allExpanded, fileIds, baseGraph, symbolCount]);
```

Add `const LOD_NODE_BUDGET = 2500;` next to `AUTO_COLLAPSE_MAX_CARDS` (~56), with a comment citing the measured ~1s-at-2.5k Smart budget. The scan seed (~310-312) stays on `AUTO_COLLAPSE_MAX_CARDS` (no expansion at scan time → cost 1 → unchanged).

- [ ] **Step 3: Pass symbol data to the canvas**

At the `<VelloGraphCanvas ... />` render site in `Explorer.tsx`, add props `symbolCount={symbolCount}` and `expanded={expanded}` (if `expanded` isn't already passed).

- [ ] **Step 4: Consume them in the cut**

In `components/VelloGraphCanvas.tsx`:

1. Add to the props interface (~40-56) and destructure (~140-160): `symbolCount: Map<string, number>;` and ensure `expanded: Set<string>;` is present.
2. Add the constant near `LOD_MAX_CARDS` (~29): `const LOD_NODE_BUDGET = 2500;`
3. Extend the `lod` ref shape (~236-247) with `symbolCount` and `expanded`, and assign them each render (mirroring `lod.current.scene = scene`):

```ts
  lod.current.symbolCount = symbolCount;
  lod.current.expanded = expanded;
```

4. In `recomputeCut`, build the cost fn and pass it into `cutOpts` (~470):

```ts
      const exp = l.expanded;
      const sc = l.symbolCount;
      const nodeCost = (id: string) => 1 + (exp.has(id) ? (sc.get(id) ?? 0) : 0);
      const cutOpts = {
        openPx: LOD_OPEN_PX, maxCards: LOD_MAX_CARDS, prevCut: l.collapsed,
        nodeBudget: LOD_NODE_BUDGET, nodeCost,
      };
```

(The same `cutOpts` object is used by both the traced and untraced branches — no other change there.)

- [ ] **Step 5: Verify the whole suite + gates**

Run: `bun test` — expected: all pass (existing LOD/scene/golden tests unaffected; the cut's default-path behavior is unchanged and only the symbol-aware budget is new).
Run: `bun run typecheck && bun run lint && bun run format:check` — expected: clean. Fix any formatting with `bun run format`.

- [ ] **Step 6: Commit**

```bash
git add components/Explorer.tsx components/VelloGraphCanvas.tsx
git commit -m "feat(lod): bound layout input on node cost so Smart stays engaged on big repos"
```

---

## Task 4: Validate end-to-end on the kernel

**Files:** none (verification only).

- [ ] **Step 1: Build** (requires the app closed). `bun run tauri build`.
- [ ] **Step 2: Launch** `src-tauri/target/release/polygraph.exe`, scan the Linux kernel.
- [ ] **Step 3: Verify** with Local logs ON, then read `src-tauri/target/release/logs/session.ndjson`:
  - The `layout` `run` events show `algorithm:"smart"` with `clusters > 0` and `layoutMs < ~1500` even after **expand-all** (no `clusters:0` grid-fallback fingerprint).
  - `nodes` per layout stays ≲ `LOD_NODE_BUDGET` (~2500), not 29k.
  - Visually: expand-all keeps the Smart clustered/organic look (not the uniform grid); zooming into a region opens detail there (Nanite), the rest stays aggregated.
- [ ] **Step 4:** If `layoutMs` still spikes or grid still appears, capture the `run`/`cut` events and tune `LOD_NODE_BUDGET` down (e.g. 2000) — do NOT raise the timeout.

---

## Self-Review

**Spec coverage:**
- "Smart stays engaged on big projects" → Tasks 1-3 bound the input below Smart's timeout so it never degrades to grid. ✓
- "LOD hides what's not in view (Nanite)" → unchanged camera-driven cut still opens detail on zoom-in; now it also respects a node budget so opening symbol-heavy regions can't blow past Smart's limit. ✓
- "expand all should expand all" → expand-all still sets every file expanded; the *view* aggregates to fit the budget (logical expansion preserved, detail revealed on zoom). Matches the approved "Full Nanite fix" framing. ✓
- Self-suspend cycle → broken at the source: no oversized input → no timeout → no grid → no `clusters===0` suspend. ✓

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `nodeCost: (fileId: string) => number` and `nodeBudget: number` are used identically in `CutOptions` (Task 1), `autoCollapseDirs`'s 3rd param (Task 2), and the component wiring (Task 3). `symbolCount: Map<string, number>` and `expanded: Set<string>` match across Explorer and VelloGraphCanvas. `LOD_NODE_BUDGET = 2500` defined in both files that reference it.

**Risk notes:** Task 1/2 changes are default-preserving (verified by the "default unchanged" tests), so the only behavioral change is in the symbol-aware paths wired in Task 3. The cut's `maxCards=800` render cap is retained, so File-level views are unchanged. `groupBy:"none"` is unaffected and remains a known LOD limitation (no clusters by design).
