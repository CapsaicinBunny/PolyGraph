// The runtime, columnar Dimension index (Phase A).
//
// Built from `(graph, catalog)`, this is the hot-path counterpart to the
// serializable `DimensionCatalog`. It assigns each node a stable **ordinal**,
// interns each dimension's values to small integer ids, and exposes columnar
// **Uint32Array** postings (node ordinals per value) built **lazily** on first
// access. Structural dimensions (kind/language/folder) are derived from the node;
// facet dimensions read `node.facets[key]`, resolving absence to the descriptor's
// `defaultValue`. The scene/group/filter/query hot paths use the interned-id API;
// `valuesOfNode` exists for CLI/debug only.
//
// Closed-domain discipline: a value not declared in a closed descriptor is still
// admitted (data is never lost), surfaced via `present()` with `declared:false`,
// and raised as an undeclared-value warning — the domain stays closed.

import type {
  CatalogWarning,
  DimensionCatalog,
  DimensionDescriptor,
  FacetKey,
  PresentDimensionValue,
} from "./dimensions";
import { fileLanguage, topFolderOf } from "./filters";
import type { GraphModel, GraphNode } from "./types";

export interface DimensionIndex {
  /** The merged descriptor for a key, or undefined if the catalog has none. */
  descriptor(key: FacetKey): DimensionDescriptor | undefined;
  /** Values observed for a key (incl. defaults), each flagged declared/undeclared. */
  present(key: FacetKey): readonly PresentDimensionValue[];
  /** Interned value ids a node (by ordinal) carries for a key. */
  valuesOfOrdinal(nodeOrdinal: number, key: FacetKey): readonly number[];
  /** Columnar posting: node ordinals carrying a value id for a key. */
  nodesWithValueId(key: FacetKey, valueId: number): Uint32Array;
  /** The string a value id interns to, for a key. */
  valueString(key: FacetKey, valueId: number): string;
  /** Non-fatal issues raised while indexing (undeclared closed values, …). */
  readonly warnings: readonly CatalogWarning[];
  /** CLI/debug only: the raw string values a node carries for a key. */
  valuesOfNode(node: GraphNode, key: FacetKey): string[];
}

const EMPTY_U32 = new Uint32Array(0);

/** Per-key interned/columnar state, built lazily on first access. */
interface KeyState {
  /** value string → interned id (first-seen order). */
  idOf: Map<string, number>;
  /** interned id → value string. */
  strings: string[];
  /** interned id → node-ordinal posting. */
  postings: Uint32Array[];
  /** interned id → declared in the (closed) domain? open domains are always true. */
  declared: boolean[];
  /** present() snapshot in first-seen order. */
  present: PresentDimensionValue[];
}

/** Resolve the string value(s) a node carries for a dimension key. */
function adapt(node: GraphNode, descriptor: DimensionDescriptor): string[] {
  if (descriptor.dimension === "structural") {
    if (descriptor.key === "kind") return [node.kind];
    if (descriptor.key === "language") return [fileLanguage(node.filePath).key];
    if (descriptor.key === "folder") return [topFolderOf(node.filePath)];
    return [];
  }
  const stored = node.facets?.[descriptor.key];
  if (stored && stored.length > 0) return stored;
  return descriptor.defaultValue !== undefined ? [descriptor.defaultValue] : [];
}

export function buildDimensionIndex(graph: GraphModel, catalog: DimensionCatalog): DimensionIndex {
  const nodes = graph.nodes;
  const byKey = new Map<FacetKey, DimensionDescriptor>();
  for (const d of catalog.descriptors) byKey.set(d.key, d);

  const states = new Map<FacetKey, KeyState>();
  const warnings: CatalogWarning[] = [];

  /**
   * Build (once) the interned tables + columnar postings for a key. Facet defaults
   * are stored as the **complement** of explicit postings — no per-node entry for
   * the ubiquitous default.
   */
  function build(descriptor: DimensionDescriptor): KeyState {
    const declaredSet = new Set(descriptor.values.map((v) => v.value));
    const idOf = new Map<string, number>();
    const strings: string[] = [];
    const declaredFlags: boolean[] = [];
    const accum: number[][] = [];

    const isFacetDefault =
      descriptor.dimension === "facet" && descriptor.defaultValue !== undefined;
    const defaultValue = descriptor.defaultValue;

    const intern = (value: string): number => {
      let id = idOf.get(value);
      if (id === undefined) {
        id = strings.length;
        idOf.set(value, id);
        strings.push(value);
        accum.push([]);
        const isDeclared = descriptor.domain === "open" || declaredSet.has(value);
        declaredFlags.push(isDeclared);
        if (!isDeclared) {
          warnings.push({
            key: descriptor.key,
            value,
            message: `Undeclared value "${value}" on closed dimension "${descriptor.key}"`,
          });
        }
      }
      return id;
    };

    // A facet default always appears in present()/counts even if no node stores it.
    if (isFacetDefault && defaultValue !== undefined) intern(defaultValue);

    const coveredByExplicit = isFacetDefault ? new Uint8Array(nodes.length) : undefined;

    for (let ordinal = 0; ordinal < nodes.length; ordinal++) {
      // Facet dims read the raw stored value(s); absence falls to the complement.
      const raw =
        descriptor.dimension === "facet"
          ? (nodes[ordinal].facets?.[descriptor.key] ?? [])
          : adapt(nodes[ordinal], descriptor);
      for (const value of raw) {
        accum[intern(value)].push(ordinal);
        if (coveredByExplicit) coveredByExplicit[ordinal] = 1;
      }
    }

    // The default value's posting is the complement of all explicit postings.
    if (isFacetDefault && defaultValue !== undefined && coveredByExplicit) {
      const defaultId = idOf.get(defaultValue)!;
      const complement = accum[defaultId];
      for (let ordinal = 0; ordinal < nodes.length; ordinal++) {
        if (coveredByExplicit[ordinal] === 0) complement.push(ordinal);
      }
    }

    const postings = accum.map((ords) => (ords.length ? Uint32Array.from(ords) : EMPTY_U32));
    const present: PresentDimensionValue[] = strings.map((value, id) => ({
      value,
      declared: declaredFlags[id],
    }));

    return { idOf, strings, postings, declared: declaredFlags, present };
  }

  function stateOf(key: FacetKey): KeyState | undefined {
    const descriptor = byKey.get(key);
    if (!descriptor) return undefined;
    let state = states.get(key);
    if (!state) {
      state = build(descriptor);
      states.set(key, state);
    }
    return state;
  }

  return {
    descriptor(key) {
      return byKey.get(key);
    },
    present(key) {
      return stateOf(key)?.present ?? [];
    },
    valuesOfOrdinal(nodeOrdinal, key) {
      const descriptor = byKey.get(key);
      const state = stateOf(key);
      if (!descriptor || !state) return [];
      const ids: number[] = [];
      for (const value of adapt(nodes[nodeOrdinal], descriptor)) {
        const id = state.idOf.get(value);
        if (id !== undefined) ids.push(id);
      }
      return ids;
    },
    nodesWithValueId(key, valueId) {
      const state = stateOf(key);
      if (!state) return EMPTY_U32;
      return state.postings[valueId] ?? EMPTY_U32;
    },
    valueString(key, valueId) {
      return stateOf(key)?.strings[valueId] ?? "";
    },
    get warnings() {
      // Force every catalog dimension to build so warnings are complete.
      for (const d of catalog.descriptors) stateOf(d.key);
      return warnings;
    },
    valuesOfNode(node, key) {
      const descriptor = byKey.get(key);
      return descriptor ? adapt(node, descriptor) : [];
    },
  };
}
