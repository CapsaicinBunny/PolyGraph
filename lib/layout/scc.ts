/** A strongly-connected component. Singletons (no cycle) come back as 1-member components. */
export interface Scc {
  id: string;
  members: string[];
}

/**
 * Strongly-connected components of a directed graph via iterative Tarjan (explicit
 * stack — safe on deep/large graphs). Deterministic: nodes and adjacency are walked
 * in sorted order, members are sorted, and components are returned in sorted id order.
 * Self-edges are ignored. `id` is `"scc:" + members.join("|")` (stable).
 */
export function stronglyConnectedComponents(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): Scc[] {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (e.source !== e.target && adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push(e.target);
    }
  }
  for (const [k, list] of adj) adj.set(k, list.sort());

  let counter = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comps: Scc[] = [];

  for (const start of [...nodeIds].sort()) {
    if (idx.has(start)) continue;
    const work: { node: string; i: number }[] = [{ node: start, i: 0 }];
    idx.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.node;
      const neighbors = adj.get(v)!;
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i];
        frame.i++;
        if (!idx.has(w)) {
          idx.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const members: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            members.push(w);
          } while (w !== v);
          members.sort();
          comps.push({ id: `scc:${members.join("|")}`, members });
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }

  return comps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
