// PivotMDS — scalable stress layout for large connected components.
//
// Full stress majorization (webcola) builds an O(n²) all-pairs distance matrix and runs
// O(n²) iterations, so it can't meet the worker's time budget much past ~800 nodes. PivotMDS
// (Brandes & Pich, 2007) approximates the same metric embedding from a handful of pivots:
// BFS distances to k landmarks (O(k·(V+E))), then classical MDS on the n×k matrix via the
// small k×k Gram matrix. Cost is ~O(k·(V+E) + n·k²) — near-linear in the graph for fixed k.
//
// Deterministic: pivots chosen by a fixed max-min rule, BFS is order-independent, the k×k
// eigenvectors come from fixed-seed power iteration with sign canonicalization.

interface Edge {
  source: string;
  target: string;
}

/** Undirected adjacency as index lists (endpoints outside the set ignored, self-loops dropped). */
function buildAdjacency(nodeIds: string[], edges: Edge[]): number[][] {
  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const adj: number[][] = nodeIds.map(() => []);
  for (const e of edges) {
    if (e.source === e.target) continue;
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    adj[s].push(t);
    adj[t].push(s);
  }
  return adj;
}

/** BFS hop distances from `start` to every node (unreachable → Infinity). */
function bfsDistances(start: number, adj: number[][]): Float64Array {
  const dist = new Float64Array(adj.length).fill(Number.POSITIVE_INFINITY);
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const dv = dist[v];
    for (const w of adj[v]) {
      if (dist[w] === Number.POSITIVE_INFINITY) {
        dist[w] = dv + 1;
        queue.push(w);
      }
    }
  }
  return dist;
}

/**
 * Max-min pivot selection (a.k.a. k-center / farthest-point): start at node 0 (the ids are
 * pre-sorted by the caller, so this is deterministic), then repeatedly pick the node farthest
 * from the chosen set. Spreads pivots across the graph so the embedding is well-conditioned.
 * Returns the pivots' BFS distance rows (one Float64Array per pivot).
 */
function pivotDistances(n: number, adj: number[][], k: number): Float64Array[] {
  const rows: Float64Array[] = [];
  const minDist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  let next = 0; // node 0 — caller sorts ids, so deterministic
  for (let p = 0; p < k; p++) {
    const row = bfsDistances(next, adj);
    rows.push(row);
    let far = -1;
    let farIdx = next;
    for (let i = 0; i < n; i++) {
      const d = Math.min(minDist[i], row[i] === Number.POSITIVE_INFINITY ? 0 : row[i]);
      minDist[i] = d;
      if (d > far) {
        far = d;
        farIdx = i;
      }
    }
    next = farIdx; // farthest from the chosen set becomes the next pivot
  }
  return rows;
}

/** Top-2 eigenvectors of a small symmetric k×k matrix via fixed-seed power iteration + deflation. */
function topTwoEigenvectors(m: number[][], k: number): [number[], number[]] {
  const ITERS = 100;
  const mul = (v: number[]): number[] => {
    const r = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) {
      let s = 0;
      const row = m[i];
      for (let j = 0; j < k; j++) s += row[j] * v[j];
      r[i] = s;
    }
    return r;
  };
  const normalize = (v: number[]): number[] => {
    let s = 0;
    for (const x of v) s += x * x;
    s = Math.sqrt(s);
    if (s > 1e-12) for (let i = 0; i < k; i++) v[i] /= s;
    return v;
  };
  const dot = (a: number[], b: number[]): number => {
    let s = 0;
    for (let i = 0; i < k; i++) s += a[i] * b[i];
    return s;
  };
  // Sign-canonicalize so the largest-magnitude entry is positive (stable across platforms).
  const canonicalize = (v: number[]): number[] => {
    let m0 = 0;
    let s = 1;
    for (const x of v)
      if (Math.abs(x) > m0) {
        m0 = Math.abs(x);
        s = x < 0 ? -1 : 1;
      }
    if (s < 0) for (let i = 0; i < k; i++) v[i] = -v[i];
    return v;
  };

  // Distinct deterministic seeds (a sine and a cosine ramp) so v1/v2 don't start parallel.
  let v1 = normalize(Array.from({ length: k }, (_, i) => Math.sin(i + 1)));
  for (let t = 0; t < ITERS; t++) v1 = normalize(mul(v1));
  v1 = canonicalize(v1);

  let v2 = normalize(Array.from({ length: k }, (_, i) => Math.cos(i + 1)));
  for (let t = 0; t < ITERS; t++) {
    const w = mul(v2);
    const d = dot(w, v1);
    for (let i = 0; i < k; i++) w[i] -= d * v1[i]; // deflate the v1 component
    v2 = normalize(w);
  }
  v2 = canonicalize(v2);
  return [v1, v2];
}

/**
 * PivotMDS embedding: returns 2-D centers keyed by node id (origin-centered, in graph-distance
 * units — the caller scales to pixels). `nodeIds` must be one connected component, pre-sorted
 * for determinism. k is clamped to [2, n].
 */
export function pivotMds(
  nodeIds: string[],
  edges: Edge[],
  k: number,
): Map<string, { x: number; y: number }> {
  const n = nodeIds.length;
  const centers = new Map<string, { x: number; y: number }>();
  if (n === 0) return centers;
  if (n <= 2) {
    nodeIds.forEach((id, i) => centers.set(id, { x: i * 200, y: 0 }));
    return centers;
  }
  const kk = Math.max(2, Math.min(k, n));
  const adj = buildAdjacency(nodeIds, edges);
  const rows = pivotDistances(n, adj, kk);

  // Squared distances (unreachable → 0 within a connected component this never triggers).
  const d2: Float64Array[] = rows.map((row) => {
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = row[i] === Number.POSITIVE_INFINITY ? 0 : row[i];
      r[i] = v * v;
    }
    return r;
  });

  // Double-center -1/2·d2 over rows (nodes) and columns (pivots): C is n×k.
  const colMean = new Float64Array(kk); // mean over nodes, per pivot
  for (let p = 0; p < kk; p++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d2[p][i];
    colMean[p] = s / n;
  }
  const rowMean = new Float64Array(n); // mean over pivots, per node
  let grand = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let p = 0; p < kk; p++) s += d2[p][i];
    rowMean[i] = s / kk;
    grand += s;
  }
  grand /= n * kk;
  // C[i][p] = -1/2 (d2 - rowMean_i - colMean_p + grand)
  const C: Float64Array[] = nodeIds.map((_, i) => {
    const r = new Float64Array(kk);
    for (let p = 0; p < kk; p++) r[p] = -0.5 * (d2[p][i] - rowMean[i] - colMean[p] + grand);
    return r;
  });

  // M = CᵀC (k×k), then its top-2 eigenvectors → principal axes.
  const m: number[][] = Array.from({ length: kk }, () => new Array<number>(kk).fill(0));
  for (let a = 0; a < kk; a++) {
    for (let b = a; b < kk; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += C[i][a] * C[i][b];
      m[a][b] = s;
      m[b][a] = s;
    }
  }
  const [w1, w2] = topTwoEigenvectors(m, kk);

  // Project: X = C·W (coords already scaled by √eigenvalue, i.e. the principal axes).
  nodeIds.forEach((id, i) => {
    let x = 0;
    let y = 0;
    const row = C[i];
    for (let p = 0; p < kk; p++) {
      x += row[p] * w1[p];
      y += row[p] * w2[p];
    }
    centers.set(id, { x, y });
  });
  return centers;
}
