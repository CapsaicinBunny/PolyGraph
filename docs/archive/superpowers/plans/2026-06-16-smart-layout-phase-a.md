# Smart Layout — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Smart" layout that groups nodes by their nested directory structure, lays each group out by dependency flow, and draws nested package containers behind the graph.

**Architecture:** A pure recursive layout (`smartLayout`) builds a directory cluster tree from node ids, lays out each cluster's items (child clusters + direct nodes) with dagre, and emits node positions plus `ClusterBox` rectangles for every nesting level. The result flows through the existing Web Worker → `Scene` → Vello WASM payload, where the renderer draws nested rounded-rect containers (depth-tinted, labelled) under the edges and nodes.

**Tech Stack:** TypeScript (pure layout + React wiring), `@dagrejs/dagre`, Bun test, Rust→WASM (`vello-renderer`, Vello/kurbo).

**Spec:** [docs/superpowers/specs/2026-06-16-smart-layout-design.md](../specs/2026-06-16-smart-layout-design.md)

---

## File Structure

- **Create** `lib/layout/clusters.ts` — build the nested directory cluster tree from layout-node ids; single-child-chain compression; per-node ancestry map. Pure.
- **Create** `lib/layout/clusters.test.ts` — tree shape, compression, ancestry, external grouping.
- **Create** `lib/layout/smart.ts` — `smartLayout(view, {direction}) → LayoutResult`; recursive multilevel layout via dagre over cluster items.
- **Create** `lib/layout/smart.test.ts` — containment, no-overlap, determinism invariants.
- **Modify** `lib/layout.ts` — add `ClusterBox` / `LayoutResult` types, `"smart"` to `LayoutAlgorithm` + `DIRECTIONAL_ALGORITHMS`, the `"smart"` case in `layoutView`, and a `{positions, clusters}` cache entry.
- **Modify** `lib/layout.worker.ts` + `lib/layout-client.ts` — carry `clusters` across the worker boundary.
- **Modify** `lib/graph/scene.ts` — `Scene.clusters`; `applyPositions` passes clusters through.
- **Modify** `components/useScene.ts` — store/restore clusters alongside positions.
- **Modify** `components/Sidebar.tsx` — add the "Smart" algorithm button.
- **Modify** `components/VelloGraphCanvas.tsx` — add `clusters` to the WASM payload.
- **Modify** `vello-renderer/src/lib.rs` — `ClusterData`; draw containers under edges/nodes; rebuild WASM.

Run all TS commands from the repo root `C:\Git\TSModuleScanner`. Tests run with `bun test <file>`.

---

### Task 1: Cluster tree + types

**Files:**
- Modify: `lib/layout.ts` (add types near the existing `LayoutOptions`, around line 49)
- Create: `lib/layout/clusters.ts`
- Create: `lib/layout/clusters.test.ts`

- [ ] **Step 1: Add the result types to `lib/layout.ts`**

Insert after the `LayoutOptions` interface (after line 49):

```ts
/** A directory/package container box emitted by the Smart layout. World-space, top-left origin. */
export interface ClusterBox {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  label: string;
}

/** Smart layout output: node positions plus the nested container boxes. */
export interface LayoutResult {
  nodes: Map<string, XYPosition>;
  clusters: ClusterBox[];
}
```

- [ ] **Step 2: Write the failing test** — `lib/layout/clusters.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { buildClusterTree } from "./clusters";

const N = (id: string, kind = "file") => ({ id, kind });

describe("buildClusterTree", () => {
  test("nests files under their directory clusters", () => {
    const { root, ancestry } = buildClusterTree([N("a/b/f.ts"), N("a/b/f.ts#x", "function"), N("a/c/g.ts")]);
    // root has one child "a" with two leaves "a/b" and "a/c"
    const a = root.children.get("a")!;
    expect(a).toBeTruthy();
    expect([...a.children.keys()].sort()).toEqual(["b", "c"]);
    expect(a.children.get("b")!.nodeIds.sort()).toEqual(["a/b/f.ts", "a/b/f.ts#x"]);
    expect(ancestry.get("a/c/g.ts")).toEqual(["a", "a/c"]);
  });

  test("compresses single-child chains into one labelled box", () => {
    const { root } = buildClusterTree([N("src/lib/graph/x.ts")]);
    const top = root.children.get("src")!;
    expect(top.id).toBe("src/lib/graph");
    expect(top.label).toBe("src/lib/graph");
    expect(top.children.size).toBe(0);
    expect(top.nodeIds).toEqual(["src/lib/graph/x.ts"]);
  });

  test("repo-root files belong to the root cluster", () => {
    const { root, ancestry } = buildClusterTree([N("README.md")]);
    expect(root.nodeIds).toEqual(["README.md"]);
    expect(ancestry.get("README.md")).toEqual([]);
  });

  test("external nodes group under one synthetic cluster", () => {
    const { root } = buildClusterTree([N("react", "external"), N("a/f.ts")]);
    expect(root.children.has("«external»")).toBe(true);
    expect(root.children.get("«external»")!.nodeIds).toEqual(["react"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test lib/layout/clusters.test.ts`
Expected: FAIL — `Cannot find module './clusters'`.

- [ ] **Step 4: Implement `lib/layout/clusters.ts`**

```ts
import type { LayoutInput } from "../layout";

/** A node in the directory cluster tree. `id` is "" for the root, else a full path like "src/lib/graph". */
export interface ClusterTreeNode {
  id: string;
  label: string;
  children: Map<string, ClusterTreeNode>;
  nodeIds: string[];
}

const EXTERNAL_DIR = "«external»";

/** Directory segments a node belongs to (external nodes group under one synthetic dir). */
function dirSegments(node: { id: string; kind: string }): string[] {
  if (node.kind === "external") return [EXTERNAL_DIR];
  const hash = node.id.indexOf("#");
  const filePath = hash === -1 ? node.id : node.id.slice(0, hash);
  const parts = filePath.split("/");
  parts.pop(); // drop the filename — we group by directory
  return parts.filter((p) => p.length > 0);
}

/**
 * Build the nested directory cluster tree from layout nodes, plus a map from each
 * node id to the chain of cluster ids that contain it (outermost first, root excluded).
 * Deterministic: nodes are inserted in id order and children iterate by sorted key.
 */
export function buildClusterTree(nodes: LayoutInput["nodes"]): {
  root: ClusterTreeNode;
  ancestry: Map<string, string[]>;
} {
  const root: ClusterTreeNode = { id: "", label: "", children: new Map(), nodeIds: [] };
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of sorted) {
    let cur = root;
    let path = "";
    for (const seg of dirSegments(n)) {
      path = path ? `${path}/${seg}` : seg;
      let child = cur.children.get(seg);
      if (!child) {
        child = { id: path, label: seg, children: new Map(), nodeIds: [] };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.nodeIds.push(n.id);
  }
  compress(root, true);
  const ancestry = new Map<string, string[]>();
  collectAncestry(root, [], ancestry);
  return { root, ancestry };
}

/** Merge a cluster with its only child when it has no direct nodes (path compression). */
function compress(node: ClusterTreeNode, isRoot: boolean): void {
  for (const child of node.children.values()) compress(child, false);
  if (isRoot) return;
  while (node.children.size === 1 && node.nodeIds.length === 0) {
    const only = [...node.children.values()][0];
    node.id = only.id;
    node.label = `${node.label}/${only.label}`;
    node.nodeIds = only.nodeIds;
    node.children = only.children;
  }
}

/** Record, for every node id, the chain of cluster ids containing it (root excluded). */
function collectAncestry(node: ClusterTreeNode, path: string[], out: Map<string, string[]>): void {
  for (const id of node.nodeIds) out.set(id, [...path]);
  for (const key of [...node.children.keys()].sort()) {
    const child = node.children.get(key)!;
    collectAncestry(child, [...path, child.id], out);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test lib/layout/clusters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/layout.ts lib/layout/clusters.ts lib/layout/clusters.test.ts
git commit -m "Smart layout: directory cluster tree + result types"
```

---

### Task 2: The `smartLayout` algorithm

**Files:**
- Create: `lib/layout/smart.ts`
- Create: `lib/layout/smart.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/layout/smart.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { ClusterBox } from "../layout";
import { smartLayout } from "./smart";

const N = (id: string, kind = "file") => ({ id, kind });

// Two packages (pkg: a→b) and a standalone util file.
const view = {
  nodes: [N("pkg/a.ts"), N("pkg/b.ts"), N("util/c.ts")],
  edges: [{ source: "pkg/a.ts", target: "pkg/b.ts" }],
};

function boxOf(clusters: ClusterBox[], id: string): ClusterBox {
  const b = clusters.find((c) => c.id === id);
  if (!b) throw new Error(`no cluster ${id}`);
  return b;
}
const overlaps = (p: ClusterBox, q: ClusterBox) =>
  p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;

describe("smartLayout", () => {
  test("emits a box per top-level directory", () => {
    const { clusters } = smartLayout(view, { direction: "LR" });
    expect(clusters.map((c) => c.id).sort()).toEqual(["pkg", "util"]);
    expect(boxOf(clusters, "pkg").depth).toBe(0);
  });

  test("every node sits inside its cluster box", () => {
    const { nodes, clusters } = smartLayout(view, { direction: "LR" });
    const pkg = boxOf(clusters, "pkg");
    for (const id of ["pkg/a.ts", "pkg/b.ts"]) {
      const p = nodes.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(pkg.x);
      expect(p.y).toBeGreaterThanOrEqual(pkg.y);
      expect(p.x).toBeLessThanOrEqual(pkg.x + pkg.width);
      expect(p.y).toBeLessThanOrEqual(pkg.y + pkg.height);
    }
  });

  test("sibling boxes do not overlap", () => {
    const { clusters } = smartLayout(view, { direction: "LR" });
    expect(overlaps(boxOf(clusters, "pkg"), boxOf(clusters, "util"))).toBe(false);
  });

  test("is deterministic", () => {
    const a = smartLayout(view, { direction: "TB" });
    const b = smartLayout(view, { direction: "TB" });
    expect([...a.nodes.entries()]).toEqual([...b.nodes.entries()]);
    expect(a.clusters).toEqual(b.clusters);
  });

  test("handles an empty graph", () => {
    const r = smartLayout({ nodes: [], edges: [] }, {});
    expect(r.nodes.size).toBe(0);
    expect(r.clusters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/layout/smart.test.ts`
Expected: FAIL — `Cannot find module './smart'`.

- [ ] **Step 3: Implement `lib/layout/smart.ts`**

```ts
import dagre from "@dagrejs/dagre";
import {
  type ClusterBox,
  type LayoutDirection,
  type LayoutInput,
  type LayoutResult,
  nodeSize,
  type XYPosition,
} from "../layout";
import { buildClusterTree, type ClusterTreeNode } from "./clusters";

const PADDING = 24;
const HEADER_H = 26;

interface ClusterLayout {
  width: number;
  height: number;
  positions: Map<string, XYPosition>; // node top-lefts, local to this cluster's top-left
  clusters: ClusterBox[]; // descendant boxes, local to this cluster's top-left
}

/** The item (child cluster id, or the node id itself) that `nodeId` maps to within cluster `sx`. */
function itemOf(sx: string, nodeId: string, ancestry: Map<string, string[]>): string | null {
  const anc = ancestry.get(nodeId) ?? [];
  if (sx === "") return anc.length > 0 ? anc[0] : nodeId;
  const i = anc.indexOf(sx);
  if (i === -1) return null; // node is not inside this cluster
  return i + 1 < anc.length ? anc[i + 1] : nodeId;
}

/** Place sized items with dagre; returns item centers. */
function dagreItems(
  items: { id: string; width: number; height: number }[],
  edges: { source: string; target: string }[],
  direction: LayoutDirection,
): Map<string, XYPosition> {
  const centers = new Map<string, XYPosition>();
  if (items.length === 0) return centers;
  const vertical = direction === "TB" || direction === "BT";
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: vertical ? 36 : 24, ranksep: vertical ? 70 : 90, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const it of items) g.setNode(it.id, { width: it.width, height: it.height });
  for (const e of edges) {
    if (e.source !== e.target && g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  for (const it of items) {
    const laid = g.node(it.id);
    centers.set(it.id, { x: laid?.x ?? 0, y: laid?.y ?? 0 }); // dagre node x/y is the center
  }
  return centers;
}

function layoutCluster(
  node: ClusterTreeNode,
  depth: number,
  direction: LayoutDirection,
  ancestry: Map<string, string[]>,
  kindOf: Map<string, string>,
  edges: LayoutInput["edges"],
): ClusterLayout {
  const isRoot = node.id === "";
  const childKeys = [...node.children.keys()].sort();

  // 1. Lay out child clusters first (bottom-up).
  const childLayouts = new Map<string, ClusterLayout>();
  for (const key of childKeys) {
    const child = node.children.get(key)!;
    childLayouts.set(child.id, layoutCluster(child, depth + 1, direction, ancestry, kindOf, edges));
  }

  // 2. Items = child clusters (box sizes) + direct nodes (node sizes).
  type Item = { id: string; width: number; height: number; child?: ClusterTreeNode };
  const items: Item[] = [];
  for (const key of childKeys) {
    const child = node.children.get(key)!;
    const cl = childLayouts.get(child.id)!;
    items.push({ id: child.id, width: cl.width, height: cl.height, child });
  }
  for (const id of [...node.nodeIds].sort()) {
    const size = nodeSize(kindOf.get(id) ?? "");
    items.push({ id, width: size.width, height: size.height });
  }

  // 3. Collapse underlying edges to item-level edges within this cluster.
  const itemEdges = new Map<string, { source: string; target: string }>();
  for (const e of edges) {
    const su = itemOf(node.id, e.source, ancestry);
    const sv = itemOf(node.id, e.target, ancestry);
    if (su == null || sv == null || su === sv) continue;
    itemEdges.set(`${su} ${sv}`, { source: su, target: sv });
  }

  // 4. Place items.
  const centers = dagreItems(items, [...itemEdges.values()], direction);

  // 5. Convert to top-lefts; place direct nodes; offset child contents.
  const positions = new Map<string, XYPosition>();
  const clusters: ClusterBox[] = [];
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const it of items) {
    const c = centers.get(it.id) ?? { x: 0, y: 0 };
    const tlx = c.x - it.width / 2;
    const tly = c.y - it.height / 2;
    placed.push({ x: tlx, y: tly, w: it.width, h: it.height });
    if (it.child) {
      const cl = childLayouts.get(it.id)!;
      clusters.push({
        id: it.id,
        parentId: isRoot ? undefined : node.id,
        x: tlx,
        y: tly,
        width: it.width,
        height: it.height,
        depth: depth + 1,
        label: it.child.label,
      });
      for (const [nid, p] of cl.positions) positions.set(nid, { x: p.x + tlx, y: p.y + tly });
      for (const b of cl.clusters) clusters.push({ ...b, x: b.x + tlx, y: b.y + tly });
    } else {
      positions.set(it.id, { x: tlx, y: tly });
    }
  }
  if (placed.length === 0) return { width: 0, height: 0, positions, clusters };

  // 6. Normalize to the cluster's inset origin and compute the box size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const dx = (isRoot ? 0 : PADDING) - minX;
  const dy = (isRoot ? 0 : PADDING + HEADER_H) - minY;
  for (const [nid, p] of positions) positions.set(nid, { x: p.x + dx, y: p.y + dy });
  for (const b of clusters) {
    b.x += dx;
    b.y += dy;
  }
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  return {
    width: isRoot ? contentW : contentW + 2 * PADDING,
    height: isRoot ? contentH : contentH + 2 * PADDING + HEADER_H,
    positions,
    clusters,
  };
}

/** Smart (semanticMultilevel) layout: group by nested directory, lay out by dependency flow. */
export function smartLayout(view: LayoutInput, options: { direction?: LayoutDirection } = {}): LayoutResult {
  const direction = options.direction ?? "TB";
  const { root, ancestry } = buildClusterTree(view.nodes);
  const kindOf = new Map(view.nodes.map((n) => [n.id, n.kind]));
  const out = layoutCluster(root, -1, direction, ancestry, kindOf, view.edges);
  return { nodes: out.positions, clusters: out.clusters };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/layout/smart.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/layout/smart.ts lib/layout/smart.test.ts
git commit -m "Smart layout: recursive multilevel layout with cluster boxes"
```

---

### Task 3: Register "smart" in `layoutView` + worker boundary

**Files:**
- Modify: `lib/layout.ts` (`LayoutAlgorithm`, `DIRECTIONAL_ALGORITHMS`, `layoutView`)
- Modify: `lib/layout.worker.ts`
- Modify: `lib/layout-client.ts`
- Create: `lib/layout-client.test.ts`

- [ ] **Step 1: Add "smart" to the algorithm types in `lib/layout.ts`**

Change line 41:
```ts
export type LayoutAlgorithm = "smart" | "layered" | "tree" | "radial" | "circular" | "grid" | "force";
```
Change line 44 (Smart uses direction for its dagre passes, so it stays directional):
```ts
export const DIRECTIONAL_ALGORITHMS: LayoutAlgorithm[] = ["smart", "layered", "tree"];
```

- [ ] **Step 2: Add the `"smart"` case to `layoutView` in `lib/layout.ts`**

At the top of `lib/layout.ts`, add the import (after the d3-force import block, ~line 9):
```ts
import { smartLayout } from "./layout/smart";
```
In the `switch (algorithm)` in `layoutView` (line 390), add as the first case:
```ts
    case "smart":
      return smartLayout(view, { direction }).nodes;
```
(`layoutView` keeps returning a `Positions` map for every algorithm; the worker reaches `smartLayout` directly for clusters in Step 4.)

- [ ] **Step 3: Write the failing test** — `lib/layout-client.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { layoutInWorker } from "./layout-client";

// In bun (no DOM Worker) layoutInWorker runs the synchronous fallback.
const view = { nodes: [{ id: "pkg/a.ts", kind: "file" }], edges: [] };

describe("layoutInWorker fallback", () => {
  test("smart returns positions and cluster boxes", async () => {
    const { positions, clusters } = await layoutInWorker(view, { algorithm: "smart", direction: "LR" });
    expect(positions.get("pkg/a.ts")).toBeTruthy();
    expect(clusters.map((c) => c.id)).toContain("pkg");
  });

  test("non-smart returns no clusters", async () => {
    const { clusters } = await layoutInWorker(view, { algorithm: "layered", direction: "LR" });
    expect(clusters).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test lib/layout-client.test.ts`
Expected: FAIL — `layoutInWorker(...).clusters` is undefined (current return is a bare `Map`).

- [ ] **Step 5: Update the worker to compute + post clusters** — replace the body of `lib/layout.worker.ts`

```ts
/// <reference lib="webworker" />
import { type LayoutInput, type LayoutOptions, layoutView } from "./layout";
import { smartLayout } from "./layout/smart";

interface Request {
  id: number;
  input: LayoutInput;
  options: LayoutOptions;
}

// Run layout off the main thread and post back flat positions + cluster boxes.
self.onmessage = (event: MessageEvent<Request>) => {
  const { id, input, options } = event.data;
  const result =
    options.algorithm === "smart"
      ? smartLayout(input, { direction: options.direction })
      : { nodes: layoutView(input, options), clusters: [] };
  const flat: [string, number, number][] = [];
  result.nodes.forEach((p, key) => flat.push([key, p.x, p.y]));
  (self as unknown as Worker).postMessage({ id, positions: flat, clusters: result.clusters });
};
```

- [ ] **Step 6: Update `lib/layout-client.ts` to resolve `{positions, clusters}`** — full new file

```ts
import {
  type ClusterBox,
  type LayoutInput,
  type LayoutOptions,
  layoutView,
  type XYPosition,
} from "./layout";
import { smartLayout } from "./layout/smart";

export interface WorkerLayout {
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}

type FlatPositions = [string, number, number][];

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (result: WorkerLayout) => void>();

function ensureWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; positions: FlatPositions; clusters: ClusterBox[] }>) => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      const positions = new Map<string, XYPosition>();
      for (const [id, x, y] of e.data.positions) positions.set(id, { x, y });
      resolve({ positions, clusters: e.data.clusters });
    };
    worker.onerror = () => {
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Synchronous fallback shared with the no-Worker path (and tests). */
function layoutSync(input: LayoutInput, options: LayoutOptions): WorkerLayout {
  if (options.algorithm === "smart") {
    const r = smartLayout(input, { direction: options.direction });
    return { positions: r.nodes, clusters: r.clusters };
  }
  return { positions: layoutView(input, options), clusters: [] };
}

/** Compute a layout on a Web Worker (or synchronously if workers are unavailable). */
export function layoutInWorker(input: LayoutInput, options: LayoutOptions): Promise<WorkerLayout> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(layoutSync(input, options));
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, input, options });
  });
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test lib/layout-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add lib/layout.ts lib/layout.worker.ts lib/layout-client.ts lib/layout-client.test.ts
git commit -m "Smart layout: register algorithm + carry clusters across the worker"
```

---

### Task 4: `Scene` carries clusters

**Files:**
- Modify: `lib/graph/scene.ts` (`Scene` interface ~line 83; `applyPositions` ~line 222)

- [ ] **Step 1: Add `clusters` to the `Scene` interface**

Replace the `Scene` interface (lines 83-87):
```ts
export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  positions: Map<string, XYPosition>;
  clusters: ClusterBox[];
}
```
Add `ClusterBox` to the existing `../layout` import (the block at line 2):
```ts
import {
  type ClusterBox,
  type LayoutAlgorithm,
  type LayoutDirection,
  type LayoutInput,
  type LayoutOptions,
  nodeSize,
  type XYPosition,
} from "../layout";
```

- [ ] **Step 2: Thread clusters through `applyPositions`**

Replace `applyPositions` (lines 222-232):
```ts
/** Apply computed positions + cluster boxes to a structure, producing a renderable scene. */
export function applyPositions(
  structure: SceneStructure,
  positions: Map<string, XYPosition>,
  clusters: ClusterBox[] = [],
): Scene {
  const nodes = structure.nodes.map((n) => {
    const p = positions.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
  return { nodes, edges: structure.edges, positions, clusters };
}
```

- [ ] **Step 3: Verify the project still typechecks**

Run: `bun run typecheck`
Expected: PASS (no output / exit 0). `useScene` still calls `applyPositions(structure, positions)` — the new `clusters` arg defaults to `[]`, so this compiles; it gets wired in Task 5.

- [ ] **Step 4: Commit**

```bash
git add lib/graph/scene.ts
git commit -m "Smart layout: Scene carries cluster boxes"
```

---

### Task 5: `useScene` + layout cache carry clusters

**Files:**
- Modify: `lib/layout.ts` (cache: lines 347-382)
- Modify: `components/useScene.ts`

- [ ] **Step 1: Make the layout cache store `{positions, clusters}` in `lib/layout.ts`**

Replace the cache section (lines 347-382) with:
```ts
// Small LRU of computed layouts, so toggling filters/algorithms back to a prior
// state (or any re-render) reuses positions + cluster boxes instead of recomputing.
export interface LayoutCacheEntry {
  positions: Positions;
  clusters: ClusterBox[];
}

const LAYOUT_CACHE_MAX = 24;
const layoutCache = new Map<string, LayoutCacheEntry>();

/** Look up a previously computed layout by signature (LRU refresh). */
export function layoutCacheGet(signature: string): LayoutCacheEntry | undefined {
  const cached = layoutCache.get(signature);
  if (cached) {
    layoutCache.delete(signature);
    layoutCache.set(signature, cached);
  }
  return cached;
}

/** Store a computed layout, evicting the oldest entry past the cap. */
export function layoutCacheSet(signature: string, entry: LayoutCacheEntry): void {
  layoutCache.set(signature, entry);
  if (layoutCache.size > LAYOUT_CACHE_MAX) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
}

/** layoutView, memoized by an externally supplied signature that uniquely identifies the view. */
export function layoutViewCached(
  signature: string,
  view: LayoutInput,
  options: LayoutOptions = {},
): Positions {
  const cached = layoutCacheGet(signature);
  if (cached) return cached.positions;
  const positions = layoutView(view, options);
  layoutCacheSet(signature, { positions, clusters: [] });
  return positions;
}
```

- [ ] **Step 2: Update `components/useScene.ts` to store + apply clusters** — full new file

```ts
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyPositions,
  buildSceneStructure,
  type Scene,
  type SceneFilters,
} from "@/lib/graph/scene";
import type { GraphModel } from "@/lib/graph/types";
import {
  type ClusterBox,
  layoutCacheGet,
  layoutCacheSet,
  type LayoutAlgorithm,
  type LayoutDirection,
  type XYPosition,
} from "@/lib/layout";
import { layoutInWorker } from "@/lib/layout-client";

const EMPTY_POS: Map<string, XYPosition> = new Map();
const EMPTY_CLUSTERS: ClusterBox[] = [];

export function useScene(
  graph: GraphModel,
  expanded: Set<string>,
  filters: SceneFilters,
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection,
): { scene: Scene; layingOut: boolean } {
  const structure = useMemo(
    () => buildSceneStructure(graph, expanded, filters, algorithm, direction),
    [graph, expanded, filters, algorithm, direction],
  );

  const initial = layoutCacheGet(structure.signature);
  const [positions, setPositions] = useState<Map<string, XYPosition>>(initial?.positions ?? EMPTY_POS);
  const [clusters, setClusters] = useState<ClusterBox[]>(initial?.clusters ?? EMPTY_CLUSTERS);
  const [layingOut, setLayingOut] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const cached = layoutCacheGet(structure.signature);
    if (cached) {
      setPositions(cached.positions);
      setClusters(cached.clusters);
      setLayingOut(false);
      return;
    }
    const myReq = ++reqId.current;
    setLayingOut(true);
    const tLayout = performance.now();
    layoutInWorker(structure.layoutInput, structure.options)
      .then(({ positions: pos, clusters: cl }) => {
        if (myReq !== reqId.current) return; // a newer request superseded this one
        console.info(
          `[polygraph] layout (${structure.options.algorithm ?? "layered"}) ${(performance.now() - tLayout).toFixed(0)}ms, ${structure.layoutInput.nodes.length} nodes`,
        );
        layoutCacheSet(structure.signature, { positions: pos, clusters: cl });
        setPositions(pos);
        setClusters(cl);
        setLayingOut(false);
      })
      .catch(() => {
        if (myReq === reqId.current) setLayingOut(false);
      });
  }, [structure]);

  const scene = useMemo(
    () => applyPositions(structure, positions, clusters),
    [structure, positions, clusters],
  );
  return { scene, layingOut };
}
```

- [ ] **Step 3: Verify typecheck + full test suite**

Run: `bun run typecheck`
Expected: PASS.
Run: `bun test`
Expected: PASS (all existing tests + the new layout tests).

- [ ] **Step 4: Commit**

```bash
git add lib/layout.ts components/useScene.ts
git commit -m "Smart layout: cache + useScene carry cluster boxes"
```

---

### Task 6: Add the "Smart" button to the layout selector

**Files:**
- Modify: `components/Sidebar.tsx` (`ALGORITHMS`, lines 63-70)

- [ ] **Step 1: Add the Smart entry as the first algorithm**

Replace the `ALGORITHMS` array (lines 63-70):
```ts
const ALGORITHMS: { value: LayoutAlgorithm; label: string; glyph: string }[] = [
  { value: "smart", label: "Smart", glyph: "✦" },
  { value: "layered", label: "Layered", glyph: "▤" },
  { value: "tree", label: "Tree", glyph: "⌄" },
  { value: "radial", label: "Radial", glyph: "◎" },
  { value: "circular", label: "Circular", glyph: "○" },
  { value: "grid", label: "Grid", glyph: "▦" },
  { value: "force", label: "Force", glyph: "✸" },
];
```
(No other change needed: `DIRECTIONAL_ALGORITHMS` already includes `"smart"` from Task 3, so the Direction selector stays enabled when Smart is active.)

- [ ] **Step 2: Verify typecheck + lint**

Run: `bun run typecheck`
Expected: PASS.
Run: `bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/Sidebar.tsx
git commit -m "Smart layout: add Smart to the layout selector"
```

---

### Task 7: Render nested containers in Vello

**Files:**
- Modify: `components/VelloGraphCanvas.tsx` (payload memo, lines 110-141)
- Modify: `vello-renderer/src/lib.rs` (`SceneData`, `render`)

- [ ] **Step 1: Add `clusters` to the WASM payload in `components/VelloGraphCanvas.tsx`**

Inside the `payload` `useMemo` (lines 110-141), before `return JSON.stringify(...)`, add:
```ts
    const clusters = scene.clusters.map((c) => ({
      x: c.x,
      y: c.y,
      w: c.width,
      h: c.height,
      depth: c.depth,
      label: c.label,
    }));
```
and change the return to:
```ts
    return JSON.stringify({ nodes, edges, clusters });
```

- [ ] **Step 2: Add the `ClusterData` struct + field in `vello-renderer/src/lib.rs`**

After the `EdgeData` struct (after line 76) add:
```rust
#[derive(Deserialize, Default)]
struct ClusterData {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    depth: u32,
    #[serde(default)]
    label: String,
}
```
Add the field to `SceneData` (after `edges: Vec<EdgeData>,`, line 81):
```rust
    #[serde(default)]
    clusters: Vec<ClusterData>,
```

- [ ] **Step 3: Draw containers under edges/nodes in `render`**

In `render` (`lib.rs`), immediately after the visible-bounds `on_screen` closure is defined (after line 250, before the `// Edges first` block at line 252) insert the container-drawing block below. It draws boxes in world space (same `camera` affine as nodes), deepest-shallowest first so parents sit under children, with a faint depth-tinted fill, a subtle border, and the label in the header. Mirror the node-label glyph drawing already in this function (the block around lines 350-375 that builds `glyphs` from `charmap`/`metrics` and calls `scene.draw_glyphs(...).draw(Fill::NonZero, ...)`) — reuse `font_ref`, `charmap`, `metrics`, the loaded `self.font`, `GLYPH_SIZE`, and `camera` exactly as that block does, positioning the baseline at `(rect_x + 10.0, rect_y + 17.0)`.

```rust
        // Package containers (Smart layout): under the edges + cards, parents first.
        {
            let mut clusters: Vec<&ClusterData> = self.data.clusters.iter().collect();
            clusters.sort_by_key(|c| c.depth);
            let border = if self.dark {
                Color::from_rgb8(71, 85, 105)
            } else {
                Color::from_rgb8(203, 213, 225)
            };
            let fill_rgb = if self.dark { 148.0 } else { 100.0 };
            for c in clusters {
                if !on_screen(c.x, c.y, c.w, c.h) {
                    continue;
                }
                // Faint fill, a touch stronger as nesting deepens.
                let alpha = (0.05 + 0.03 * c.depth as f32).min(0.16);
                let fill = Color::new([
                    fill_rgb / 255.0,
                    fill_rgb / 255.0,
                    (fill_rgb + 20.0) / 255.0,
                    alpha,
                ]);
                let rect = RoundedRect::new(c.x, c.y, c.x + c.w, c.y + c.h, 14.0);
                self.scene.fill(Fill::NonZero, camera, fill, None, &rect);
                self.scene
                    .stroke(&Stroke::new(1.0), camera, border, None, &rect);

                // Header label — mirror the node-label glyph-drawing block in this fn.
                if !c.label.is_empty() {
                    let mut pen_x = c.x + 10.0;
                    let baseline_y = c.y + 17.0;
                    let mut glyphs = Vec::new();
                    for ch in c.label.chars() {
                        let gid = charmap.map(ch).unwrap_or_default();
                        let advance = metrics.advance_width(gid).unwrap_or(0.0) as f64;
                        glyphs.push(vello::Glyph {
                            id: gid.to_u32(),
                            x: pen_x as f32,
                            y: baseline_y as f32,
                        });
                        pen_x += advance;
                    }
                    self.scene
                        .draw_glyphs(&self.font)
                        .font_size(GLYPH_SIZE)
                        .brush(border)
                        .transform(camera)
                        .draw(Fill::NonZero, glyphs.into_iter());
                }
            }
        }
```
If any helper name (e.g. `gid.to_u32()`, `metrics.advance_width`) differs from the existing label block, match that block's exact calls — it is the source of truth for this codebase's Vello text API.

- [ ] **Step 4: Build the WASM renderer**

Run (from repo root):
```bash
bun run --cwd vello-renderer build 2>&1 | tail -5 || (cd vello-renderer && wasm-pack build --target web --release)
```
First check `vello-renderer/package.json` for the exact build script; use it. Expected: a successful build writing `vello-renderer/pkg/`. If the build prints Rust errors about the text API, reconcile with the existing node-label block per Step 3 and rebuild.

- [ ] **Step 5: Manual verification**

Run `bun run dev`, scan this repo (`C:\Git\TSModuleScanner`), choose the **Smart** layout. Expected: top-level rounded containers labelled `app`, `components`, `lib`, `src-tauri`, `vello-renderer`, etc., with files nested inside, dependency arrows flowing in the selected direction (LR/TB), and containers sitting *behind* the cards and edges. Toggle a folder off in Filters → its box disappears. Switch to Layered → containers disappear.

- [ ] **Step 6: Commit**

```bash
git add components/VelloGraphCanvas.tsx vello-renderer/src/lib.rs vello-renderer/pkg
git commit -m "Smart layout: render nested package containers in Vello"
```

---

## Final verification

- [ ] `bun run typecheck` — clean
- [ ] `bun run lint` — clean
- [ ] `bun run format:check` — clean (run `bun run format` if needed, recommit)
- [ ] `bun test` — all pass
- [ ] Manual: Smart layout renders nested labelled containers with dependency flow; non-smart layouts unaffected.

## Notes for the implementer

- This is **Phase A** of a larger plan (B: adaptive per-cluster + SCC; C: semantic reduction + collapse/expand; D: edge routing/bundling; E: control panel + community detection). Do not pull those in — the foundation here (the `LayoutResult` + cluster-tree contract) is what they build on.
- Run TS commands from `C:\Git\TSModuleScanner`. In the Bash tool, prefix with `cd /c/Git/TSModuleScanner &&`.
- Commit as **CapsaicinBunny**; do **not** add a `Co-Authored-By: Claude` trailer.
- Determinism matters (the layout cache keys on a signature): keep the sorted iteration in `clusters.ts`/`smart.ts`.
