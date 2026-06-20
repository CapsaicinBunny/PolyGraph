// The transitional DirectoryLodSelection bridge (Phase C0). The camera's adaptive cut
// still measures the live scene and produces a *collapsed* directory set via
// `computeCut` (lod-cut.ts) — that machinery is unchanged. This module converts that
// collapsed set into the **selection layer** the three-layer collapse model consumes:
// the set of directories the cut wants OPEN (spec → "Three-layer collapse": the camera
// owns only the LOD selection; it must never write user intent or the bootstrap).
//
// Why an open-set: the bootstrap layer closes the whole directory *safety universe*
// (allDirectoryGroupIds), and `compose()` lets the selection OPEN regions back up
// (precedence: user-closed > user-open > selection-open > bootstrap). Composing
// (∅ intent, all-dirs bootstrap, this selection) reproduces the camera's collapsed set
// EXACTLY, so the rendered scene is identical to the pre-refactor path that fed
// `computeCut` straight to `collapseClusters` — but now user intent can override it and
// the camera can no longer clobber that intent.
//
// Pure; no React.

import { directoryGroupId, type GroupId } from "./grouping";
import { buildDirTree, dirIndex } from "./hierarchy";
import type { GraphModel } from "./types";

/**
 * The set of directories (namespaced group ids) a collapsed cut leaves OPEN: a directory
 * is open iff neither it nor any of its ancestors appears in `collapsed`. `collapsed` is
 * the bare-path output of `computeCut` (outermost-collapsed frontier); a node under a
 * collapsed ancestor is absorbed, so its directory is *not* open. Directories named in
 * `collapsed` that don't exist in this graph close nothing real and are ignored.
 */
export function directoryLodSelection(
  collapsed: ReadonlySet<string>,
  graph: GraphModel,
): Set<GroupId> {
  const dirs = dirIndex(buildDirTree(graph));
  const open = new Set<GroupId>();
  for (const path of dirs.keys()) {
    if (!isUnderCut(path, collapsed)) open.add(directoryGroupId(path));
  }
  return open;
}

/** True when `path` or any of its directory ancestors is in the collapsed set. */
function isUnderCut(path: string, collapsed: ReadonlySet<string>): boolean {
  let cur = path;
  while (cur) {
    if (collapsed.has(cur)) return true;
    const slash = cur.lastIndexOf("/");
    cur = slash === -1 ? "" : cur.slice(0, slash);
  }
  return false;
}
