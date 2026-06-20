// The adaptive level-of-detail cut — the heart of "Nanite for graphs"
// (docs/SCALE-100K.md). Given the directory tree, a stable world-space box per
// directory, and the camera, decide which directories to collapse so the visible
// scene shows detail where the user is looking and aggregate cards elsewhere,
// with on-screen card count bounded regardless of repo size.
//
// Output is a Set<string> of collapsed directory ids — exactly the shape
// `collapseClusters` (and today's `collapsedClusters` state) already consumes, so
// it drops into the existing scene pipeline with no downstream change. Pure and
// deterministic; the entire feature's behavior is verified here without a GPU.

import type { DirNode } from "./hierarchy";
import {
  type Box,
  type Camera,
  intersectsViewport,
  screenHeight,
  type Viewport,
  worldToScreen,
} from "./lod-screen";

export interface CutOptions {
  /** Minimum on-screen box height (px) for a directory to open into its children. */
  openPx: number;
  /** Cap on rendered cards; opens stop once the estimate reaches this. */
  maxCards: number;
  /** Re-collapse a previously-open dir only below `openPx * hysteresis` (anti-thrash). */
  hysteresis?: number;
  /** The previous cut, for hysteresis. */
  prevCut?: Set<string>;
  /** Viewport cull margin (px), matching the renderer's on-screen padding. */
  margin?: number;
  /**
   * Layout-node cost of opening one file — `1 + its visible symbols`. Defaults to 1
   * (file = card). When files are expanded their symbols enter the layout too, so a
   * dir can be cheap in CARDS yet far too expensive in NODES for the layout engine.
   */
  nodeCost?: (fileId: string) => number;
  /**
   * Cap on estimated layout NODES (opened files × {@link nodeCost} + aggregate cards).
   * Opens stop once this is reached, keeping the input small enough that Smart lays it
   * out within its interactive budget instead of timing out to a grid. Default Infinity.
   */
  nodeBudget?: number;
}

export type CutDecision = "open" | "collapse";
/** Why a directory was collapsed (or, for "opened", that it was opened). */
export type CutReason = "off-screen" | "too-small" | "no-content" | "budget" | "opened";

/** One directory's decision during a cut — the per-dir telemetry trace entry. */
export interface CutTraceEntry {
  path: string;
  depth: number;
  onScreen: boolean;
  screenHeightPx: number;
  thresholdPx: number;
  decision: CutDecision;
  reason: CutReason;
}

/** Full cut result with telemetry: the collapsed set plus why each dir landed there. */
export interface CutResult {
  cut: Set<string>;
  trace: CutTraceEntry[];
  /** Directories examined this cut. */
  dirsEvaluated: number;
  /** Of those, how many were on screen. */
  dirsOnScreen: number;
  /** Estimated rendered cards (collapsed aggregates + opened files). */
  cards: number;
}

/**
 * Core cut walk. When `trace` is non-null, every directory's decision is recorded
 * (the telemetry path); when null, it's the zero-allocation hot path. Walks the
 * tree top-down (heaviest child first): a directory is collapsed (one aggregate
 * card) when off-screen, too small to be legible, contentless, or the card budget
 * is spent; otherwise it opens and its children recurse. The cut holds only the
 * outermost collapsed dirs, matching `collapseClusters`' absorption.
 */
function cutCore(
  root: DirNode,
  boxes: Map<string, Box>,
  cam: Camera,
  vp: Viewport,
  opts: CutOptions,
  trace: CutTraceEntry[] | null,
): CutResult {
  const {
    openPx,
    maxCards,
    hysteresis = 0.8,
    prevCut,
    margin = 0,
    nodeCost = () => 1,
    nodeBudget = Infinity,
  } = opts;
  const collapsed = new Set<string>();
  let cards = 0;
  let nodes = 0;
  let dirsEvaluated = 0;
  let dirsOnScreen = 0;

  const wasOpen = (path: string) => prevCut !== undefined && !prevCut.has(path);
  // Layout-node cost of opening this dir's direct files (default 1 each = file count).
  const openCost = (node: DirNode) => {
    let c = 0;
    for (const f of node.files) c += nodeCost(f);
    return c;
  };

  const record = (
    node: DirNode,
    onScreen: boolean,
    screenHeightPx: number,
    thresholdPx: number,
    decision: CutDecision,
    reason: CutReason,
  ) => {
    dirsEvaluated += 1;
    if (onScreen) dirsOnScreen += 1;
    if (decision === "collapse") {
      collapsed.add(node.path);
      cards += 1;
      nodes += 1; // an aggregate card is one layout node
    }
    if (trace) {
      trace.push({
        path: node.path,
        depth: node.depth,
        onScreen,
        screenHeightPx,
        thresholdPx,
        decision,
        reason,
      });
    }
  };

  const visit = (node: DirNode) => {
    const box = boxes.get(node.path);
    if (!box || !intersectsViewport(worldToScreen(box, cam), vp, margin)) {
      record(node, false, box ? screenHeight(box, cam.scale) : 0, openPx, "collapse", "off-screen");
      return;
    }
    const threshold = wasOpen(node.path) ? openPx * hysteresis : openPx;
    const sh = screenHeight(box, cam.scale);
    const hasContent = node.children.length + node.files.length > 0;
    if (!hasContent) return record(node, true, sh, threshold, "collapse", "no-content");
    if (sh < threshold) return record(node, true, sh, threshold, "collapse", "too-small");
    if (cards + node.files.length > maxCards || nodes + openCost(node) > nodeBudget) {
      return record(node, true, sh, threshold, "collapse", "budget");
    }
    // Open: direct files render individually; recurse into child dirs.
    record(node, true, sh, threshold, "open", "opened");
    cards += node.files.length;
    nodes += openCost(node);
    for (const child of node.children) {
      if (cards >= maxCards || nodes >= nodeBudget) {
        const cb = boxes.get(child.path);
        record(child, !!cb, cb ? screenHeight(cb, cam.scale) : 0, openPx, "collapse", "budget");
        continue;
      }
      visit(child);
    }
  };

  // Root-level files (directly at the repo root) can't be absorbed by any directory
  // collapse, so they always render. Count them up front so the node budget reserves
  // headroom for them and doesn't over-open dirs on top. (Node budget only — leaves the
  // card-count path, and thus default behavior, untouched.)
  for (const f of root.files) nodes += nodeCost(f);

  for (const child of root.children) {
    if (cards >= maxCards || nodes >= nodeBudget) {
      const cb = boxes.get(child.path);
      record(child, !!cb, cb ? screenHeight(cb, cam.scale) : 0, openPx, "collapse", "budget");
      continue;
    }
    visit(child);
  }
  return { cut: collapsed, trace: trace ?? [], dirsEvaluated, dirsOnScreen, cards };
}

/** The collapsed-directory set for the current camera (zero-overhead hot path). */
export function computeCut(
  root: DirNode,
  boxes: Map<string, Box>,
  cam: Camera,
  vp: Viewport,
  opts: CutOptions,
): Set<string> {
  return cutCore(root, boxes, cam, vp, opts, null).cut;
}

/** Like {@link computeCut}, but also returns the per-directory decision trace + counts. */
export function computeCutTraced(
  root: DirNode,
  boxes: Map<string, Box>,
  cam: Camera,
  vp: Viewport,
  opts: CutOptions,
): CutResult {
  return cutCore(root, boxes, cam, vp, opts, []);
}

/** Set equality for two collapsed sets (drives the no-op skip on camera moves). */
export function cutEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
