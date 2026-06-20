// Connection highlighting over the ON-SCREEN graph: given the visible scene edges
// (whose source/target are whatever cards are currently drawn — aggregates, files,
// or symbols), compute what to light up when the user selects a card (its direct
// neighbors) or two cards (the shortest path between them, or "no connection").
// Operates on scene ids directly, so it works at any collapse/expand level.

export interface ConnectionEdge {
  source: string;
  target: string;
  kind?: string;
}

// Structural/containment edges describe the folder→file→symbol hierarchy, not a code
// relationship — letting a path step through them produces "connections" that just walk the
// directory tree. They're excluded from the adjacency so paths run through real dependencies.
const NON_RELATIONSHIP_KINDS = new Set(["contains"]);

/**
 * Undirected neighbor sets from the scene edges (self-loops and containment edges dropped).
 * Undirected on purpose: "is A connected to B at all" ignores dependency direction. The status
 * label reflects that (no directional arrow); directed path modes are a future option.
 */
export function buildAdjacency(edges: ConnectionEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (e.kind !== undefined && NON_RELATIONSHIP_KINDS.has(e.kind)) continue;
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return adj;
}

/** Shortest undirected path between two cards (inclusive), or null if unconnected. */
export function connectionPath(
  a: string,
  b: string,
  adj: Map<string, Set<string>>,
): string[] | null {
  if (a === b) return [a];
  const prev = new Map<string, string>();
  const visited = new Set<string>([a]);
  const queue = [a];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const nb of adj.get(cur) ?? []) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      prev.set(nb, cur);
      if (nb === b) {
        const path = [b];
        let p = cur;
        while (p !== a) {
          path.push(p);
          p = prev.get(p)!;
        }
        path.push(a);
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

export interface ConnectionHighlight {
  /** Card ids to keep lit (everything else dims). */
  nodeIds: Set<string>;
  /** pairKey() of each EXACT highlighted edge — only the anchor↔neighbor / on-path edges, not
   * every edge whose endpoints happen to be lit (e.g. a B–C chord when A's neighbors are lit). */
  edgePairs: Set<string>;
  /** The shortest path (two connected anchors), else null. */
  path: string[] | null;
  /** False only when two anchors have no path between them. */
  connected: boolean;
}

/**
 * Order-independent key for an undirected card pair. Length-prefixed so it's collision-free
 * regardless of what characters the ids contain (no NUL separator).
 */
export function pairKey(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x.length}:${x}${y}`;
}

/**
 * What to highlight for the current selection: one anchor → the card and its direct neighbors
 * (and the anchor→neighbor edges); two anchors → the shortest path between them and its edges
 * (connected), or just the two cards (connected: false) when there's no path. Null when nothing
 * is selected. Edges are returned EXACTLY (as pairKeys) so only real connection edges light —
 * not incidental edges between two independently-lit nodes.
 */
export function connectionHighlight(
  anchors: string[],
  adj: Map<string, Set<string>>,
): ConnectionHighlight | null {
  if (anchors.length === 0) return null;
  if (anchors.length === 1) {
    const a = anchors[0];
    const nodeIds = new Set<string>([a]);
    const edgePairs = new Set<string>();
    for (const nb of adj.get(a) ?? []) {
      nodeIds.add(nb);
      edgePairs.add(pairKey(a, nb));
    }
    return { nodeIds, edgePairs, path: null, connected: true };
  }
  const [a, b] = anchors;
  const path = connectionPath(a, b, adj);
  if (path) {
    const edgePairs = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) edgePairs.add(pairKey(path[i], path[i + 1]));
    return { nodeIds: new Set(path), edgePairs, path, connected: true };
  }
  return { nodeIds: new Set([a, b]), edgePairs: new Set(), path: null, connected: false };
}

/**
 * The anchor state machine for a card click. Pure so the interaction is testable.
 * - plain click (shift=false) → just that card (select + highlight its neighbors).
 * - shift, no anchor yet → establish the first endpoint.
 * - shift, one anchor, a different card → second endpoint (show the path).
 * - shift, one anchor, the SAME card → unchanged (no misleading zero-step path).
 * - shift, already a full path → start a fresh path from the clicked card.
 */
export function nextAnchors(prev: string[], id: string, shift: boolean): string[] {
  if (!shift) return prev.length === 1 && prev[0] === id ? prev : [id];
  if (prev.length === 0) return [id];
  if (prev.length === 1) return prev[0] === id ? prev : [prev[0], id];
  return [id];
}

/**
 * Drop anchors whose card has left the scene (an LOD/collapse transition can remove a selected
 * node). Returns the SAME array reference when nothing changed, so feeding it straight into a
 * state setter won't trigger a needless re-render.
 */
export function pruneAnchors(prev: string[], sceneIds: Set<string>): string[] {
  const next = prev.filter((id) => sceneIds.has(id));
  return next.length === prev.length ? prev : next;
}

/**
 * Status-pill text for the two-anchor case (null otherwise). Deliberately NON-directional —
 * the adjacency is undirected, so it must not imply a dependency arrow.
 */
export function connectionStatus(
  anchors: string[],
  highlight: ConnectionHighlight | null,
  labelOf: (id: string) => string,
): { text: string; ok: boolean } | null {
  if (!highlight || anchors.length < 2) return null;
  const [a, b] = anchors;
  if (!highlight.connected) {
    return { text: `No connection between ${labelOf(a)} and ${labelOf(b)}`, ok: false };
  }
  const steps = (highlight.path?.length ?? 1) - 1;
  return {
    text: `${labelOf(a)} ⇄ ${labelOf(b)} · ${steps} step${steps === 1 ? "" : "s"}`,
    ok: true,
  };
}
