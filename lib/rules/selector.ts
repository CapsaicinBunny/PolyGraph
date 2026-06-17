// Match a single graph node against a normalized NodeSelector. Facets present in
// the selector are AND-ed; entries within a facet are OR-ed. A facet that is
// empty is simply ignored (it places no constraint).

import { matchAnyGlob } from "../glob/match";
import type { GraphNode } from "../graph/types";
import type { NodeSelector } from "../config/schema";

export function matchNode(selector: NodeSelector, node: GraphNode): boolean {
  if (selector.paths.length > 0 && !matchAnyGlob(selector.paths, node.filePath)) return false;
  if (selector.kinds.length > 0 && !selector.kinds.includes(node.kind)) return false;
  if (selector.roles.length > 0 && (!node.role || !selector.roles.includes(node.role)))
    return false;
  if (
    selector.environments.length > 0 &&
    (!node.environment || !selector.environments.includes(node.environment))
  ) {
    return false;
  }
  if (
    selector.categories.length > 0 &&
    (!node.category || !selector.categories.includes(node.category))
  ) {
    return false;
  }
  return true;
}
