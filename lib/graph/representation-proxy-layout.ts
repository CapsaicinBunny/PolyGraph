// Stable, layout-INDEPENDENT proxy geometry (design Gap 3 / "Not actually layout-independent",
// P2). The representation cut today derives every proxy's box from the LIVE scene's cluster
// boxes (`scene.clusters` / aggregate cards) — geometry the VISUAL node-layout engine produces.
// But Grid, the classic engines, and None emit NO cluster boxes, so under those engines every
// proxy reads as "off-screen, height 0": `canRefine` short-circuits, the viewport-distance
// arbitration sees no geometry, and the canvas EARLY-RETURNS on `boxes.size === 0` — the cut is
// inert. "Layout-independent" then means only that the cut ignores the engine NAME, not that it
// OPERATES with every engine.
//
// This module is the missing source of STABLE proxy box geometry: a deterministic hierarchical
// layout over the persistent RepresentationHierarchy that produces a bounded `current` rectangle
// (bounds*) for EVERY rep — group reps, leaf reps, and render-only intermediate / bootstrap
// proxies — as a pure function of the hierarchy STRUCTURE alone. It reads nothing from any visual
// engine, so the cut has bounds under Grid/Stress/Force/None exactly as under Smart. The selected
// visual layout still places node geometry; these bounds are the representation boxes INTO which
// it places it (and the fallback the cut measures when the engine emits no box for a group).
//
// The layout is a SQUARIFIED-style nested treemap: each rep is allotted a rectangle whose AREA is
// proportional to its subtree leaf count (so a big group gets a big box, a leaf a unit box), and a
// rep's children tile its interior. It is bounded (a fixed world canvas), stable (a function of the
// rep tree, not the camera), and deterministic (children tiled in ascending rep-id order). It
// feeds `computeRepresentationBounds` (representation-bounds.ts), which then derives the tiered
// nextReserved / growthEnvelope / minScale from these `current` boxes.
//
// Pure; deterministic; no React, no GPU; reads only the columnar hierarchy.

import type { RepresentationColumns, RepresentationHierarchy } from "./representation";

/**
 * A persistent SNAPSHOT of the stable proxy geometry (the four parallel arrays the layout wrote
 * into the columns). The cut overwrites `bounds*` from the live scene boxes each recut, so the
 * runtime keeps this immutable copy and falls back to it whenever a rep has no live box — that
 * fallback is what makes the cut OPERATE under every engine (design Gap 3). Indexed by rep id.
 */
export interface StableProxyBounds {
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
}

/** Read a rep's stable box (the engine-independent fallback geometry). */
export function stableProxyBoundsOf(
  b: StableProxyBounds,
  rep: number,
): { x: number; y: number; w: number; h: number } {
  return { x: b.x[rep], y: b.y[rep], w: b.w[rep], h: b.h[rep] };
}

/** Tuning for the stable proxy layout. All world-space units (the cut scales by the camera). */
export interface ProxyLayoutOptions {
  /** Side length of the square world canvas the whole forest is laid out within. */
  worldSize: number;
  /** Inset (world units) between a parent box and its children's tiling area — visual breathing. */
  padding: number;
  /** Minimum side (world units) of any rep box, so a single leaf is never sub-pixel/zero. */
  minSide: number;
}

/**
 * Side length of the FIXED square world canvas the whole proxy forest is tiled within. The
 * stable bounds are therefore in a coordinate space that is INDEPENDENT of the live visual
 * layout's extent — which is exactly why the cut's refine gate must rescale them by
 * `liveExtent / PROXY_WORLD_SIZE` before measuring them against the camera (which is fit to the
 * LIVE layout's much larger world). Without that calibration a top-level proxy projects to a few
 * pixels at the fitted camera and nothing clears `openPx` — the collapse↔refine limit cycle. The
 * cut owns the calibration; this module just defines the canonical canvas size both sides agree on.
 */
export const PROXY_WORLD_SIZE = 4096;

/**
 * Defaults sized so a typical proxy box is ~hundreds of world units — the same order as the
 * Smart layout's cluster boxes, so the cut's screen-size gate (`openPx`, hundreds of px at
 * scale ~1) behaves comparably whether bounds come from the engine or from this stable layout.
 */
export const DEFAULT_PROXY_LAYOUT_OPTIONS: ProxyLayoutOptions = {
  worldSize: PROXY_WORLD_SIZE,
  padding: 8,
  minSide: 24,
};

/**
 * Version of the stable proxy LAYOUT (the tiling algorithm + its area/padding rules). The
 * bounds are a pure function of the hierarchy structure, so they are cached ON the runtime on
 * the SAME material signature as the hierarchy; this constant is folded into that signature
 * (see `lod-representation-cut.ts`) so a layout-algorithm change invalidates cached bounds.
 */
export const PROXY_LAYOUT_VERSION = "rpl1";

/**
 * Compute STABLE world-space `current` bounds for every rep and write them into the hierarchy's
 * geometry columns (`boundsX/Y/W/H`), layout-independent of any visual engine (design Gap 3).
 *
 * The whole forest is tiled inside one `worldSize × worldSize` canvas: the roots tile the canvas
 * (area ∝ subtree leaf count), then each rep's children tile its padded interior recursively. The
 * result is bounded (every box ⊆ the canvas), deterministic (children tiled in ascending rep-id
 * order), and a pure function of the rep tree — so it is identical under Grid, Stress, Force, None
 * and Smart. DETACHED reps (post-filter-hidden — `parentByRep === -2`) and empty subtrees get a
 * zero box (they are not in the rendered scene, so they need no geometry).
 *
 * Idempotent and total: every non-detached rep ends with a positive box, so the cut ALWAYS has
 * bounds to measure regardless of the active engine. Call once per runtime build (the geometry is
 * structural, not per-camera); a camera recut never re-runs this.
 *
 * Returns an immutable {@link StableProxyBounds} SNAPSHOT of the geometry it wrote, so the caller
 * (the persistent runtime) can keep the stable bounds even after a recut overwrites the live
 * `bounds*` columns from the visual engine's scene boxes.
 */
export function computeStableProxyBounds(
  h: RepresentationHierarchy,
  options: ProxyLayoutOptions = DEFAULT_PROXY_LAYOUT_OPTIONS,
): StableProxyBounds {
  const cols = h.columns;
  const { worldSize, padding, minSide } = options;

  // Subtree leaf count drives each box's AREA (a leaf weighs 1; a proxy weighs its leaves). The
  // hierarchy already rolls this up structurally; recompute it here from the tree so this module
  // is self-contained and does not depend on the optional cost columns being a leaf COUNT (they
  // carry weighted nodeCost). One post-order over the child links.
  const leafWeight = subtreeLeafWeights(cols, h.repCount, h.roots);

  // Zero every box first; detached / empty reps then stay at zero (no geometry — not rendered).
  cols.boundsX.fill(0);
  cols.boundsY.fill(0);
  cols.boundsW.fill(0);
  cols.boundsH.fill(0);

  // Tile the roots inside the world canvas, then recurse. The roots' combined weight fills the
  // whole canvas; an empty forest (no visible roots) leaves every box at zero.
  layoutChildrenOf(cols, leafWeight, h.roots, 0, 0, worldSize, worldSize, padding, minSide);

  // Snapshot the geometry so the runtime can keep it after a recut overwrites the columns from
  // the live scene boxes (the engine-independent fallback — design Gap 3).
  return {
    x: Float32Array.from(cols.boundsX),
    y: Float32Array.from(cols.boundsY),
    w: Float32Array.from(cols.boundsW),
    h: Float32Array.from(cols.boundsH),
  };
}

/**
 * Tile `children` inside the rectangle [x, y, w, h] (squarified treemap), assign each child its
 * box, and recurse into each child's padded interior. Children are ordered by DESCENDING weight
 * for squarification quality, ties broken by ASCENDING rep id for determinism. A degenerate
 * (zero-area / zero-weight) slot still gets a `minSide` box so no rep is sub-pixel.
 */
function layoutChildrenOf(
  cols: RepresentationColumns,
  leafWeight: Float64Array,
  children: readonly number[],
  x: number,
  y: number,
  w: number,
  h: number,
  padding: number,
  minSide: number,
): void {
  if (children.length === 0 || w <= 0 || h <= 0) return;

  // Stable order: heavier first (squarify packs better), rep id ascending on ties (determinism).
  const order = [...children].sort((a, b) => {
    const d = leafWeight[b] - leafWeight[a];
    return d !== 0 ? d : a - b;
  });

  const totalWeight = order.reduce((s, c) => s + Math.max(leafWeight[c], 1), 0);
  // Squarified row packing: greedily fill rows along the shorter side so boxes stay near-square.
  const rects = squarify(
    order.map((c) => Math.max(leafWeight[c], 1)),
    x,
    y,
    w,
    h,
    totalWeight,
  );

  for (let i = 0; i < order.length; i++) {
    const rep = order[i];
    const r = rects[i];
    const bw = Math.max(r.w, minSide);
    const bh = Math.max(r.h, minSide);
    cols.boundsX[rep] = r.x;
    cols.boundsY[rep] = r.y;
    cols.boundsW[rep] = bw;
    cols.boundsH[rep] = bh;

    // Recurse into this rep's children inside its PADDED interior (so nesting reads visibly and a
    // child box is strictly inside its parent — the cut's ancestor geometry stays well-formed).
    const kids = childrenOf(cols, rep);
    if (kids.length > 0) {
      const ix = r.x + padding;
      const iy = r.y + padding;
      const iw = Math.max(bw - 2 * padding, minSide);
      const ih = Math.max(bh - 2 * padding, minSide);
      layoutChildrenOf(cols, leafWeight, kids, ix, iy, iw, ih, padding, minSide);
    }
  }
}

interface LaidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A simple squarified treemap row packer (Bruls/Huizing/van Wijk, simplified). Lays `weights`
 * (already ordered, descending) into [x,y,w,h], packing greedily into rows along the shorter
 * edge so aspect ratios stay near 1. Deterministic; returns one rect per weight in input order.
 */
function squarify(
  weights: readonly number[],
  x: number,
  y: number,
  w: number,
  h: number,
  totalWeight: number,
): LaidRect[] {
  const out: LaidRect[] = new Array(weights.length);
  const totalArea = w * h;
  // Area each weight is entitled to (proportional to weight). Guard a zero total.
  const scale = totalWeight > 0 ? totalArea / totalWeight : 0;
  const areas = weights.map((wt) => wt * scale);

  let i = 0;
  // Remaining free rectangle.
  let fx = x;
  let fy = y;
  let fw = w;
  let fh = h;

  while (i < areas.length) {
    // Pack a row along the shorter side of the remaining free rect.
    const horizontal = fw >= fh; // lay the row across the longer-edge width? pack along shorter.
    const rowThickness0 = Math.min(fw, fh);
    if (rowThickness0 <= 0) {
      // Degenerate free space — give every remaining item a zero rect (caller clamps to minSide).
      for (; i < areas.length; i++) out[i] = { x: fx, y: fy, w: 0, h: 0 };
      break;
    }

    // Greedily grow the row while it improves the worst aspect ratio.
    let rowEnd = i;
    let rowArea = 0;
    let bestRatio = Number.POSITIVE_INFINITY;
    while (rowEnd < areas.length) {
      const tryArea = rowArea + areas[rowEnd];
      const thickness = tryArea / rowThickness0; // row depth for this area along the long side
      const ratio = worstRatio(areas.slice(i, rowEnd + 1), rowThickness0, thickness);
      if (ratio <= bestRatio) {
        bestRatio = ratio;
        rowArea = tryArea;
        rowEnd++;
      } else {
        break;
      }
    }
    if (rowEnd === i) {
      // The first item alone didn't "improve" — still place it as a one-item row.
      rowArea = areas[i];
      rowEnd = i + 1;
    }

    const thickness = rowThickness0 > 0 ? rowArea / rowThickness0 : 0;
    // Lay the row items across `rowThickness0`, each sized by its share of the row.
    let cursor = 0;
    for (let k = i; k < rowEnd; k++) {
      const frac = rowArea > 0 ? areas[k] / rowArea : 1 / (rowEnd - i);
      const along = rowThickness0 * frac;
      if (horizontal) {
        // Row runs DOWN the height (thickness along width). Items stacked along height.
        out[k] = { x: fx, y: fy + cursor, w: thickness, h: along };
      } else {
        // Row runs ACROSS the width (thickness along height). Items along width.
        out[k] = { x: fx + cursor, y: fy, w: along, h: thickness };
      }
      cursor += along;
    }

    // Shrink the free rect by the consumed row.
    if (horizontal) {
      fx += thickness;
      fw -= thickness;
    } else {
      fy += thickness;
      fh -= thickness;
    }
    i = rowEnd;
  }

  return out;
}

/** Worst aspect ratio (max(side/other, other/side)) of a row of `areas` of given thickness. */
function worstRatio(areas: readonly number[], rowSide: number, thickness: number): number {
  if (thickness <= 0 || rowSide <= 0) return Number.POSITIVE_INFINITY;
  let worst = 1;
  for (const a of areas) {
    const along = a / thickness; // length of this item along the row
    if (along <= 0) {
      worst = Number.POSITIVE_INFINITY;
      continue;
    }
    const ratio = Math.max(along / thickness, thickness / along);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/** Children of `rep` in ascending rep-id order (firstChild/nextSibling is descending → reverse). */
function childrenOf(cols: RepresentationColumns, rep: number): number[] {
  const out: number[] = [];
  for (let c = cols.firstChildByRep[rep]; c !== -1; c = cols.nextSiblingByRep[c]) out.push(c);
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Subtree leaf weight per rep (a leaf weighs 1; a proxy weighs the sum of its descendant leaves),
 * computed by one iterative post-order over the child links — independent of the cost columns
 * (which carry weighted nodeCost, not a leaf COUNT). Detached / unreachable reps stay 0.
 */
function subtreeLeafWeights(
  cols: RepresentationColumns,
  repCount: number,
  roots: readonly number[],
): Float64Array {
  const weight = new Float64Array(repCount);
  // Pre-order push, collect, then accumulate child→parent in reverse (children before parents).
  const order: number[] = [];
  const stack: number[] = [...roots];
  while (stack.length > 0) {
    const r = stack.pop()!;
    order.push(r);
    for (let c = cols.firstChildByRep[r]; c !== -1; c = cols.nextSiblingByRep[c]) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const r = order[i];
    if (cols.firstChildByRep[r] === -1) weight[r] = 1; // leaf
    const p = cols.parentByRep[r];
    if (p >= 0) weight[p] += Math.max(weight[r], 1);
  }
  return weight;
}
