// The material-change relayout gate (spec non-negotiable + "Global layout stability").
// Phase C1c Task 5.
//
// A GLOBAL relayout — recomputing the stable repository layout (the major groups' box
// origins every local refinement is offset against) — happens ONLY on a MATERIAL change:
// filters, grouping mode, direction, an explicit user request, or envelope exhaustion (a
// refinement that even a scoped subtree relayout couldn't absorb). It NEVER happens for an
// ordinary camera-driven refinement.
//
// The mechanism is a GlobalLayoutInputs record that carries ONLY material inputs — it has
// NO camera/scale/LOD-cut field — so a camera refinement is physically incapable of
// changing `globalLayoutSignature`. `globalRelayoutReason` diffs two input records and
// names the material change (or null). The camera/LOD cut lives entirely in the C1b
// runtime (lod-runtime.ts) and the local-refinement layer (local-refine.ts); neither feeds
// this signature. Pure; no React, no GPU.

import type { LayoutDirection } from "../layout";

/**
 * The MATERIAL inputs a global (repository) layout depends on. Deliberately excludes
 * anything camera/LOD: the box origins must not move when the user pans, zooms, or the
 * cut refines. `explicitRelayoutNonce`/`envelopeExhaustedNonce` are monotonic counters the
 * caller bumps to REQUEST a relayout (an explicit "re-layout" command; an envelope-
 * exhaustion event from the overflow ladder's final rung) — the only camera-adjacent
 * triggers, and both are explicit signals, not continuous camera state.
 */
export interface GlobalLayoutInputs {
  /** Identity of the analyzed graph (a re-scan changes it). */
  graphVersion: string;
  /** Canonical signature of the active filter selections. */
  filterSignature: string;
  /** The grouping mode key ("directory" / "community" / "facet:env" / …). */
  groupingMode: string;
  /** Flow direction for the directional engines. */
  direction: LayoutDirection;
  /** The chosen layout engine ("smart" / "layered" / …). */
  layoutEngine: string;
  /** A hash of the remaining layout options (density, etc.). */
  layoutOptionsHash: string;
  /** Monotonic counter bumped by an EXPLICIT user relayout request. */
  explicitRelayoutNonce: number;
  /** Monotonic counter bumped when the overflow ladder exhausts a group's envelope. */
  envelopeExhaustedNonce: number;
}

/** Why a global relayout fired (or null when no material input changed). */
export type GlobalRelayoutReason =
  | "graph"
  | "filters"
  | "grouping-mode"
  | "direction"
  | "engine"
  | "layout-options"
  | "explicit"
  | "envelope-exhausted";

// The fields the signature concatenates, in a fixed order, so it is insensitive to object
// property order. EVERY field here is material — none is camera/LOD — which is the whole
// point: a camera refinement changes none of them.
const FIELDS: readonly (keyof GlobalLayoutInputs)[] = [
  "graphVersion",
  "filterSignature",
  "groupingMode",
  "direction",
  "layoutEngine",
  "layoutOptionsHash",
  "explicitRelayoutNonce",
  "envelopeExhaustedNonce",
];

/**
 * A canonical signature of the material layout inputs. Two input records with the same
 * material values produce the same signature regardless of property insertion order — and
 * crucially, a camera refinement (which changes no field here) can never change it. The
 * caller recomputes the global layout iff this signature changes.
 */
export function globalLayoutSignature(inputs: GlobalLayoutInputs): string {
  let out = "";
  for (const f of FIELDS) out += `${f}=${String(inputs[f])}|`;
  return out;
}

/**
 * The material reason a global relayout should fire between `prev` and `next`, or null
 * when nothing material changed (e.g. a pure camera refinement). Checked in a fixed
 * precedence so a single transition reports a single, stable reason.
 */
export function globalRelayoutReason(
  prev: GlobalLayoutInputs,
  next: GlobalLayoutInputs,
): GlobalRelayoutReason | null {
  if (prev.graphVersion !== next.graphVersion) return "graph";
  if (prev.filterSignature !== next.filterSignature) return "filters";
  if (prev.groupingMode !== next.groupingMode) return "grouping-mode";
  if (prev.direction !== next.direction) return "direction";
  if (prev.layoutEngine !== next.layoutEngine) return "engine";
  if (prev.layoutOptionsHash !== next.layoutOptionsHash) return "layout-options";
  if (prev.explicitRelayoutNonce !== next.explicitRelayoutNonce) return "explicit";
  if (prev.envelopeExhaustedNonce !== next.envelopeExhaustedNonce) return "envelope-exhausted";
  return null;
}
