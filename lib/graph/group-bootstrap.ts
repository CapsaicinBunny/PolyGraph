// The mode-agnostic BOOTSTRAP seed for the representation LOD. The C1a camera cut
// (`computeGroupCut`, `lod-cut.ts`, `lod-selection.ts`) has been retired (spec P5 —
// "Representation-LOD unification"): the representation cut is the sole LOD authority.
// What survives here is the geometry-free machinery that translates intent/bootstrap into
// the three-layer `compose()` seed the representation cut renders ON TOP of (spec: "What
// stays TEMPORARILY — compose() for … translating intent/bootstrap into solver
// constraints"):
//
//   • `budgetGroupCut`   — the geometry-free initial budget cut (no camera/boxes) that
//                          bounds the FIRST frame of a large non-directory graph before
//                          the camera ever moves; the mode-agnostic analog of
//                          `autoCollapseDirs` (the Directory seed).
//   • `groupLodSelection`— converts a collapsed BOX-KEY set into the OPEN namespaced
//                          group-id selection the three-layer `compose()` consumes.
//   • `groupCutEquals`   — set equality for two collapsed box-key sets.
//
// Pure and deterministic; verified without a GPU.

import type { CompactGroupingSnapshot } from "./grouping-snapshot";
import { NO_GROUP } from "./grouping-snapshot";
import type { GroupId } from "./collapse-model";

/** Per-group precomputed structure derived from a snapshot (children + direct members). */
interface GroupTree {
  childrenOf: number[][]; // group ordinal → child ordinals
  membersOf: string[][]; // group ordinal → DIRECT member node ids
  subtreeNodes: number[]; // group ordinal → total member count in its subtree
}

/** Build the children adjacency + per-group direct members from a snapshot. */
function groupTree(snapshot: CompactGroupingSnapshot, nodeIds: readonly string[]): GroupTree {
  const n = snapshot.groupIds.length;
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  const membersOf: string[][] = Array.from({ length: n }, () => []);
  for (let g = 0; g < n; g++) {
    const p = snapshot.parentByGroup[g];
    if (p !== -1) childrenOf[p].push(g);
  }
  for (let i = 0; i < snapshot.directGroupByNode.length; i++) {
    const g = snapshot.directGroupByNode[i];
    if (g !== NO_GROUP && g < n) membersOf[g].push(nodeIds[i] ?? String(i));
  }
  // Subtree member counts (post-order over the parent links).
  const subtreeNodes = new Array<number>(n).fill(0);
  // Process deepest-first via depthByGroup ordering.
  const order = Array.from({ length: n }, (_, g) => g).sort(
    (a, b) => snapshot.depthByGroup[b] - snapshot.depthByGroup[a],
  );
  for (const g of order) {
    let total = membersOf[g].length;
    for (const c of childrenOf[g]) total += subtreeNodes[c];
    subtreeNodes[g] = total;
  }
  // Heaviest child first (then boxKey) — mirrors buildDirTree's child ordering.
  for (let g = 0; g < n; g++) {
    childrenOf[g].sort(
      (a, b) =>
        subtreeNodes[b] - subtreeNodes[a] ||
        (snapshot.boxKeyByGroup[a] < snapshot.boxKeyByGroup[b] ? -1 : 1),
    );
  }
  return { childrenOf, membersOf, subtreeNodes };
}

/** Options for the geometry-free initial budget cut. */
export interface BudgetCutOptions {
  /** Cap on rendered cards; opens stop once the estimate reaches this. */
  maxCards: number;
  /** Cap on estimated layout NODES; opens stop once reached. Default Infinity. */
  nodeBudget?: number;
  /** Layout-node cost of opening one member node (default 1 = a card). */
  nodeCost?: (nodeId: string) => number;
}

/**
 * The geometry-free, budget-bounded initial cut over ANY grouping mode — the
 * mode-agnostic analog of `autoCollapseDirs` (the Directory seed). It has no camera/boxes:
 * it assumes every group is on-screen and opens groups heaviest-first until the card / node
 * budget is spent, so the FIRST frame of a large non-directory graph is bounded before the
 * camera ever moves. The representation cut then refines from here as the user zooms.
 *
 * Returns the collapsed BOX-KEY set, or `null` when the whole snapshot already fits the
 * budget (so the caller can leave everything open and turn LOD OFF — matching Directory's
 * `autoCollapseDirs(...) === null` "graph fits, no LOD" path). Feeding the result through
 * {@link groupLodSelection} yields the open-selection seed; the bootstrap is the full
 * group-id set ("everything starts closed").
 */
export function budgetGroupCut(
  snapshot: CompactGroupingSnapshot,
  opts: BudgetCutOptions,
  nodeIds: readonly string[] = [],
): Set<string> | null {
  const { maxCards, nodeBudget = Infinity, nodeCost = () => 1 } = opts;
  const tree = groupTree(snapshot, nodeIds);

  // Total layout cost if EVERYTHING opened (every direct member as a card). When this
  // fits both budgets there is nothing to bound — return null (LOD off).
  let totalCost = 0;
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    for (const id of tree.membersOf[g]) totalCost += nodeCost(id);
  }
  const totalCards = snapshot.directGroupByNode.length;
  if (totalCards <= maxCards && totalCost <= nodeBudget) return null;

  const collapsed = new Set<string>();
  let cards = 0;
  let nodes = 0;
  const openCost = (g: number) => {
    let c = 0;
    for (const id of tree.membersOf[g]) c += nodeCost(id);
    return c;
  };
  const collapse = (g: number) => {
    collapsed.add(snapshot.boxKeyByGroup[g]);
    cards += 1;
    nodes += 1; // an aggregate card is one layout node
  };
  const visit = (g: number) => {
    const hasContent = tree.childrenOf[g].length + tree.membersOf[g].length > 0;
    if (!hasContent) return collapse(g);
    if (cards + tree.membersOf[g].length > maxCards || nodes + openCost(g) > nodeBudget) {
      return collapse(g);
    }
    cards += tree.membersOf[g].length;
    nodes += openCost(g);
    for (const c of tree.childrenOf[g]) {
      if (cards >= maxCards || nodes >= nodeBudget) {
        collapse(c);
        continue;
      }
      visit(c);
    }
  };
  // Roots heaviest-first (stable budget spending).
  const roots = [...snapshot.roots].sort(
    (a, b) =>
      tree.subtreeNodes[b] - tree.subtreeNodes[a] ||
      (snapshot.boxKeyByGroup[a] < snapshot.boxKeyByGroup[b] ? -1 : 1),
  );
  for (const r of roots) {
    if (cards >= maxCards || nodes >= nodeBudget) {
      collapse(r);
      continue;
    }
    visit(r);
  }
  return collapsed;
}

/**
 * Convert a collapsed BOX-KEY set to the GroupLodSelection: the OPEN namespaced group
 * ids. A group is open iff neither it nor any of its ancestors is collapsed. Feeding this
 * to the three-layer `compose()` (with the all-groups bootstrap) reproduces the collapsed
 * scene while letting user intent override — the seed owns only this selection layer.
 */
export function groupLodSelection(
  collapsed: ReadonlySet<string>,
  snapshot: CompactGroupingSnapshot,
): Set<GroupId> {
  const open = new Set<GroupId>();
  for (let g = 0; g < snapshot.groupIds.length; g++) {
    if (!isUnderCut(g, snapshot, collapsed)) open.add(snapshot.groupIds[g]);
  }
  return open;
}

/** True when group `g` or any of its ancestor groups has its box key in `collapsed`. */
function isUnderCut(
  g: number,
  snapshot: CompactGroupingSnapshot,
  collapsed: ReadonlySet<string>,
): boolean {
  let cur = g;
  let guard = snapshot.groupIds.length + 1;
  while (cur !== -1 && guard-- > 0) {
    if (collapsed.has(snapshot.boxKeyByGroup[cur])) return true;
    cur = snapshot.parentByGroup[cur];
  }
  return false;
}

/** Set equality for two collapsed box-key sets. */
export function groupCutEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
