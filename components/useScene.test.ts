// The MATERIAL-signature strip that makes the C1c HierarchicalLayout reconcile reuse unchanged
// groups byte-identically across recuts (spec P3 / Work item 1 / B3). The cut term embedded in a
// scene structure signature is `rep:${materialSignature}#${generation}`; the reconcile key must be
// STABLE across recuts of the same material, i.e. the per-cut GENERATION must be fully removed.
//
// This is the regression guard for a real wiring bug: `materialSignature` (lod-representation-cut)
// is itself a `|`-joined string, so the original naive `\|rep:[^|]*` strip removed only its first
// `g=…` part and LEFT the trailing `#${generation}` in the signature — which then changed every
// recut and silently defeated the entire byte-identical layer (every recut moved every group).
// We build the salt from the REAL materialSignature so the strip cannot drift from that format.

import { describe, expect, test } from "bun:test";
import { materialSignatureFromStructureSignature } from "./useScene";
import { materialSignature } from "@/lib/graph/lod-representation-cut";

// A faithful scene structure signature: the same `|`-joined shape scene.ts builds, with the cut
// term `rep:${salt}` where salt = `${materialSignature}#${generation}` (VelloGraphCanvas).
function structureSig(salt: string): string {
  return [
    "graph:abc",
    "cat:0",
    "smart",
    "TB",
    "x1",
    "exp:",
    "f:none",
    "ek:all",
    "fld:all",
    "lng:all",
    `rep:${salt}`,
    "directory",
    "d1",
    "focus:none",
    "q:none",
    "p0",
  ].join("|");
}

// The real material signature the canvas feeds into the salt — crucially this is itself
// `|`-joined, which is exactly what broke the naive strip.
function realSalt(generation: number): string {
  const sig = materialSignature({
    snapshot: { modeKey: "directory" } as never,
    boxes: [] as never,
    intent: new Map() as never,
    options: {} as never,
    filteredGraphId: "1:2",
    groupingVersion: 0,
    nodeCostSignature: "3:4",
    nodeIds: [],
  } as never);
  return `${sig}#${generation}`;
}

describe("materialSignatureFromStructureSignature — strips the per-cut generation", () => {
  test("the real `|`-joined materialSignature body survives the strip", () => {
    const out = materialSignatureFromStructureSignature(structureSig(realSalt(7)));
    // The material body (e.g. the mode part `m=directory`) must remain — it distinguishes materials.
    expect(out).toContain("m=directory");
    // ...but the generation suffix must be gone.
    expect(out).not.toContain("#7");
  });

  test("STABLE across generations: same material, different generation → identical strip", () => {
    const g7 = materialSignatureFromStructureSignature(structureSig(realSalt(7)));
    const g8 = materialSignatureFromStructureSignature(structureSig(realSalt(8)));
    const g999 = materialSignatureFromStructureSignature(structureSig(realSalt(999)));
    expect(g7).toBe(g8);
    expect(g8).toBe(g999);
  });

  test("a DIFFERENT material (different filtered-graph id) → different strip (no false reuse)", () => {
    const a = materialSignatureFromStructureSignature(structureSig(realSalt(1)));
    const otherSalt = `${materialSignature({
      snapshot: { modeKey: "directory" } as never,
      boxes: [] as never,
      intent: new Map() as never,
      options: {} as never,
      filteredGraphId: "9:9", // a different filtered graph → different material
      groupingVersion: 0,
      nodeCostSignature: "3:4",
      nodeIds: [],
    } as never)}#1`;
    const b = materialSignatureFromStructureSignature(structureSig(otherSalt));
    expect(a).not.toBe(b);
  });

  test("the rep term at the END of the signature still has its generation stripped", () => {
    const sig = `graph:abc|rep:${realSalt(42)}`;
    expect(materialSignatureFromStructureSignature(sig)).not.toContain("#42");
  });

  test("a later `#<digits>` token (e.g. a focus id) is NOT touched — only the cut generation is", () => {
    const sig = `${structureSig(realSalt(7)).replace("focus:none", "focus:node#99")}`;
    const out = materialSignatureFromStructureSignature(sig);
    expect(out).toContain("node#99"); // a real material/focus token is preserved
    expect(out).not.toContain("#7"); // the cut generation is still removed
  });
});
