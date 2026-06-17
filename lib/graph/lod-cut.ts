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
}

/**
 * Compute the collapsed-directory set for the current camera. Walks the tree
 * top-down (heaviest child first — the tree is pre-sorted): a directory is
 * collapsed (shown as one aggregate card) when it is off-screen, too small to be
 * legible, or the card budget is spent; otherwise it opens and its children are
 * tested recursively. The cut contains only the outermost collapsed dirs (the
 * frontier), matching `collapseClusters`' outermost-first absorption.
 */
export function computeCut(
  root: DirNode,
  boxes: Map<string, Box>,
  cam: Camera,
  vp: Viewport,
  opts: CutOptions,
): Set<string> {
  const { openPx, maxCards, hysteresis = 0.8, prevCut, margin = 0 } = opts;
  const collapsed = new Set<string>();
  let cards = 0; // running estimate of rendered cards

  const wasOpen = (path: string) => prevCut !== undefined && !prevCut.has(path);

  const collapse = (node: DirNode) => {
    collapsed.add(node.path);
    cards += 1; // one aggregate card
  };

  const visit = (node: DirNode) => {
    const box = boxes.get(node.path);
    // No box (shouldn't happen) or off-screen → collapse to one card.
    if (!box || !intersectsViewport(worldToScreen(box, cam), vp, margin)) {
      collapse(node);
      return;
    }
    // Legibility threshold, with hysteresis for a dir that's already open.
    const threshold = wasOpen(node.path) ? openPx * hysteresis : openPx;
    const openable = screenHeight(box, cam.scale) >= threshold;
    const hasContent = node.children.length + node.files.length > 0;
    // Budget: opening adds this dir's direct files as cards; if that alone blows
    // the budget, collapse instead.
    if (!openable || !hasContent || cards + node.files.length > maxCards) {
      collapse(node);
      return;
    }
    // Open: direct files render individually; recurse into child dirs.
    cards += node.files.length;
    for (const child of node.children) {
      if (cards >= maxCards) {
        collapse(child); // budget spent — remaining children stay aggregated
        continue;
      }
      visit(child);
    }
  };

  for (const child of root.children) {
    if (cards >= maxCards) {
      collapse(child);
      continue;
    }
    visit(child);
  }
  return collapsed;
}

/** Set equality for two collapsed sets (drives the no-op skip on camera moves). */
export function cutEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
