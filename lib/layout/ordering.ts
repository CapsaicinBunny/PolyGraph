// Ordering toolkit — node orderings shared by the graph-aware layouts (circular,
// radial, grid, layered). Ordering is deliberately SEPARATE from placement: an
// engine asks for a 1-D order here, then maps it onto a ring / row / layer. Every
// function is deterministic (sorted iteration, stable tie-breaks, no RNG) so the
// signature-keyed layout cache stays valid.

interface Edge {
  source: string;
  target: string;
}

/** Undirected neighbor sets (self-loops dropped, endpoints outside the set ignored). */
function undirectedAdjacency(nodeIds: string[], edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of edges) {
    if (e.source === e.target) continue;
    const s = adj.get(e.source);
    const t = adj.get(e.target);
    if (!s || !t) continue;
    s.add(e.target);
    t.add(e.source);
  }
  return adj;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Collision-free keys for node-id pairs. Node ids are arbitrary strings (file paths, symbol
// ids), so a visible separator can alias — "a b" + "c" and "a" + "b c" both make "a b c".
// length-prefixed keys (see edgeKey below) make the split unambiguous.
/** Key for a DIRECTED (source → target) id pair. */
export function edgeKey(source: string, target: string): string {
  return `${source.length}:${source}${target}`;
}
/** Key for an UNORDERED id pair (same key regardless of argument order). */
export function undirectedKey(a: string, b: string): string {
  return a < b ? edgeKey(a, b) : edgeKey(b, a);
}

/**
 * Reverse Cuthill–McKee ordering: a bandwidth-reducing permutation that keeps
 * connected nodes close together in the sequence. Each component is seeded at its
 * minimum-degree node (ties by id), grown breadth-first visiting neighbors in
 * ascending degree, then reversed. Components are emitted in seed (min-degree, id)
 * order. Deterministic. Good for circular/grid locality.
 */
export function rcmOrder(nodeIds: string[], edges: Edge[]): string[] {
  const adj = undirectedAdjacency(nodeIds, edges);
  const degree = (id: string): number => adj.get(id)?.size ?? 0;
  const byDegreeThenId = (a: string, b: string): number => degree(a) - degree(b) || byId(a, b);

  const seeds = [...nodeIds].sort(byDegreeThenId);
  const visited = new Set<string>();
  const result: string[] = [];

  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    const cm: string[] = [];
    const queue: string[] = [seed];
    visited.add(seed);
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i];
      cm.push(v);
      const neighbors = [...(adj.get(v) ?? [])].filter((n) => !visited.has(n)).sort(byDegreeThenId);
      for (const n of neighbors) {
        visited.add(n);
        queue.push(n);
      }
    }
    for (let i = cm.length - 1; i >= 0; i--) result.push(cm[i]);
  }
  return result;
}

/** Connected components (undirected), each sorted by id, components ordered by min id. */
function connectedComponents(nodeIds: string[], adj: Map<string, Set<string>>): string[][] {
  const visited = new Set<string>();
  const comps: string[][] = [];
  for (const seed of [...nodeIds].sort(byId)) {
    if (visited.has(seed)) continue;
    const comp: string[] = [];
    const queue = [seed];
    visited.add(seed);
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i];
      comp.push(v);
      for (const n of adj.get(v) ?? []) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    comp.sort(byId);
    comps.push(comp);
  }
  return comps;
}

const SPECTRAL_ITERATIONS = 128;

/** Fiedler vector of one connected component (≥3 nodes) via deterministic power iteration. */
function fiedlerComponent(comp: string[], adj: Map<string, Set<string>>): string[] {
  const n = comp.length;
  const index = new Map(comp.map((id, i) => [id, i]));
  const degree = comp.map((id) => adj.get(id)?.size ?? 0);
  let maxDegree = 0;
  for (const d of degree) if (d > maxDegree) maxDegree = d;
  // M = cI - L has the same eigenvectors as L but with the order flipped, so power
  // iteration (which finds the largest eigenvalue) lands on L's smallest non-trivial
  // one — the Fiedler vector — once the constant vector is deflated out each step.
  const c = 2 * maxDegree + 1;

  // Deterministic non-constant seed (a ramp), made mean-zero so it's ⊥ to the constant.
  let x = comp.map((_, i) => i - (n - 1) / 2);
  const deflateAndNormalize = (v: number[]): number[] => {
    let mean = 0;
    for (const t of v) mean += t;
    mean /= n;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      v[i] -= mean;
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-12) for (let i = 0; i < n; i++) v[i] /= norm;
    return v;
  };
  x = deflateAndNormalize(x);

  for (let iter = 0; iter < SPECTRAL_ITERATIONS; iter++) {
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let neighborSum = 0;
      for (const nb of adj.get(comp[i]) ?? []) {
        const j = index.get(nb);
        if (j !== undefined) neighborSum += x[j];
      }
      // (M x)_i = c*x_i - (L x)_i = c*x_i - (deg_i*x_i - sum_neighbors x_j)
      y[i] = c * x[i] - (degree[i] * x[i] - neighborSum);
    }
    x = deflateAndNormalize(y);
  }

  const order = [...comp].sort((a, b) => x[index.get(a)!] - x[index.get(b)!] || byId(a, b));
  // Canonicalize the (arbitrary) eigenvector sign so the orientation is deterministic.
  if (order.length > 1 && order[0] > order[order.length - 1]) order.reverse();
  return order;
}

/** Metadata layers for the deterministic tie-break. All optional; absent layers are skipped. */
export interface TieBreakMeta {
  /** Manually pinned nodes — sorted before everything else. */
  pinned?: Set<string>;
  /** Position in the previous ordering — preserves the mental map across re-layouts. */
  previousIndex?: Map<string, number>;
  /** Detected community id. */
  community?: Map<string, string>;
  /** Architectural depth (e.g. rank / dependency depth) — shallower first. */
  archDepth?: Map<string, number>;
  /** Node kind. */
  kind?: Map<string, string>;
}

/** File path portion of a node id (`path#symbol` → `path`). */
function pathOf(id: string): string {
  const h = id.indexOf("#");
  return h === -1 ? id : id.slice(0, h);
}

/** Directory of a node id's file path (`a/b/c.ts#x` → `a/b`). */
function directoryOf(id: string): string {
  const p = pathOf(id);
  const s = p.lastIndexOf("/");
  return s === -1 ? "" : p.slice(0, s);
}

const LAST = "￿"; // sorts after any real label, so "missing" trails "present"

/**
 * The one deterministic tie-break used everywhere a stable, mental-map-preserving
 * order is needed: `pinned → previousPosition → community → directory → archDepth →
 * kind → path → id`. Each layer only discriminates when both nodes carry the data;
 * `directory`/`path` are derived from the id, so the fallback is always meaningful.
 */
export function stableComparator(meta: TieBreakMeta = {}): (a: string, b: string) => number {
  const { pinned, previousIndex, community, archDepth, kind } = meta;
  return (a, b) => {
    if (pinned) {
      const pa = pinned.has(a) ? 0 : 1;
      const pb = pinned.has(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    if (previousIndex) {
      const pa = previousIndex.get(a) ?? Number.POSITIVE_INFINITY;
      const pb = previousIndex.get(b) ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
    }
    if (community) {
      const ca = community.get(a) ?? LAST;
      const cb = community.get(b) ?? LAST;
      if (ca !== cb) return byId(ca, cb);
    }
    const da = directoryOf(a);
    const db = directoryOf(b);
    if (da !== db) return byId(da, db);
    if (archDepth) {
      const aa = archDepth.get(a) ?? Number.POSITIVE_INFINITY;
      const ab = archDepth.get(b) ?? Number.POSITIVE_INFINITY;
      if (aa !== ab) return aa - ab;
    }
    if (kind) {
      const ka = kind.get(a) ?? LAST;
      const kb = kind.get(b) ?? LAST;
      if (ka !== kb) return byId(ka, kb);
    }
    const pa = pathOf(a);
    const pb = pathOf(b);
    if (pa !== pb) return byId(pa, pb);
    return byId(a, b);
  };
}

/** Sort node ids by the deterministic tie-break stack. */
export function stableOrder(ids: string[], meta: TieBreakMeta = {}): string[] {
  return [...ids].sort(stableComparator(meta));
}

/** A neighbor's position in the adjacent (fixed) layer/ring, with its edge weight. */
export interface WeightedPos {
  pos: number;
  weight: number;
}

/** Weighted average of neighbor positions (the barycenter), or null when there are none. */
export function barycenterValue(neighbors: WeightedPos[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const { pos, weight } of neighbors) {
    weighted += pos * weight;
    total += weight;
  }
  return total === 0 ? null : weighted / total;
}

/**
 * Reorder a free layer toward its neighbors' fixed positions (the barycenter
 * crossing-reduction heuristic). Nodes with no neighbors keep their current slot
 * (their index is used as the barycenter), and the sort is stable, so the pass is
 * deterministic and a single sweep never gratuitously reshuffles unconnected nodes.
 */
export function orderByBarycenter(
  layer: string[],
  neighborsOf: (id: string) => WeightedPos[],
): string[] {
  const ranked = layer.map((id, index) => ({
    id,
    index,
    value: barycenterValue(neighborsOf(id)) ?? index,
  }));
  ranked.sort((a, b) => a.value - b.value || a.index - b.index);
  return ranked.map((r) => r.id);
}

/** A neighbor's angle on an adjacent ring, with its edge weight. */
export interface WeightedAngle {
  angle: number;
  weight: number;
}

/**
 * Reorder a ring toward its neighbors' angular positions using the CIRCULAR mean
 * (the resultant of the weighted unit vectors), not a linear average of indices.
 * Linear barycenter wraps badly on a ring — neighbors at angles ~0 and ~2π average to
 * π (the opposite side) instead of ~0. Nodes with no placed neighbors keep their slot
 * (sorted stably after the rest). Deterministic.
 */
export function orderByCircularBarycenter(
  ring: string[],
  neighborsOf: (id: string) => WeightedAngle[],
): string[] {
  const ranked = ring.map((id, index) => {
    let sin = 0;
    let cos = 0;
    let total = 0;
    for (const { angle, weight } of neighborsOf(id)) {
      sin += Math.sin(angle) * weight;
      cos += Math.cos(angle) * weight;
      total += weight;
    }
    // atan2(0,0)=0 would be a false "angle 0"; mark neighborless nodes null instead.
    const value = total === 0 ? null : Math.atan2(sin, cos);
    return { id, index, value };
  });
  ranked.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value === null && b.value === null) return a.index - b.index;
      return a.value === null ? 1 : -1; // neighborless nodes trail, stably
    }
    return a.value - b.value || a.index - b.index;
  });
  return ranked.map((r) => r.id);
}

/**
 * Spectral (Fiedler-vector) ordering: a 1-D layout that places strongly connected
 * nodes close together by minimizing squared edge length. Computed per connected
 * component (components emitted by min id); components of ≤2 nodes fall back to id
 * order. Deterministic (fixed seed + fixed iterations + sign canonicalization).
 * Good for circular ordering and grid embedding of small/medium clusters.
 */
export function fiedlerOrder(nodeIds: string[], edges: Edge[]): string[] {
  const adj = undirectedAdjacency(nodeIds, edges);
  const result: string[] = [];
  for (const comp of connectedComponents(nodeIds, adj)) {
    const ordered = comp.length <= 2 ? [...comp].sort(byId) : fiedlerComponent(comp, adj);
    for (const id of ordered) result.push(id);
  }
  return result;
}
