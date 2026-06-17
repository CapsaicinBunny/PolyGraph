/**
 * Deterministic label-propagation community detection over an undirected view of
 * the dependency graph. Classic LPA is randomized; this variant fixes node order
 * (sorted) and breaks ties by smallest label, so the same input always yields the
 * same communities (required by the layout cache). Returns nodeId → community id
 * (`"Community N"`, N assigned by first appearance in sorted node order).
 */
export function detectCommunities(
  nodeIds: string[],
  edges: { source: string; target: string }[],
  maxIterations = 20,
): Map<string, string> {
  const nodes = [...nodeIds].sort();
  const adj = new Map<string, string[]>();
  for (const id of nodes) adj.set(id, []);
  for (const e of edges) {
    if (e.source !== e.target && adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }
  }
  for (const [k, list] of adj) adj.set(k, list.sort());

  const label = new Map<string, string>();
  for (const id of nodes) label.set(id, id);

  // Synchronous updates: each pass computes new labels from the PREVIOUS snapshot,
  // then applies them together. Asynchronous (in-place) updates with a smallest-label
  // tie-break collapse separate clusters across a single bridge edge; synchronous
  // propagation keeps dense groups distinct.
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Map<string, string>();
    let changed = false;
    for (const id of nodes) {
      const neighbors = adj.get(id)!;
      if (neighbors.length === 0) {
        next.set(id, label.get(id)!);
        continue;
      }
      // Most frequent neighbor label; ties broken by smallest label string.
      const counts = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestCount = -1;
      for (const [l, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (c > bestCount) {
          best = l;
          bestCount = c;
        }
      }
      next.set(id, best);
      if (best !== label.get(id)) changed = true;
    }
    for (const [k, v] of next) label.set(k, v);
    if (!changed) break;
  }

  // Canonicalize: number communities by first appearance in sorted node order.
  const idByLabel = new Map<string, string>();
  let next = 1;
  const out = new Map<string, string>();
  for (const id of nodes) {
    const l = label.get(id)!;
    let cid = idByLabel.get(l);
    if (!cid) {
      cid = `Community ${next++}`;
      idByLabel.set(l, cid);
    }
    out.set(id, cid);
  }
  return out;
}
