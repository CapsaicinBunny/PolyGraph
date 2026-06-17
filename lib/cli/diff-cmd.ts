// `polygraph diff` — scan two points in history (default: main ↔ working tree),
// diff their graphs, and report what changed. The JSON form is the payload a UI
// diff view consumes; the text form is the compact PR-review summary.

import { diffGraphs } from "../diff/diff";
import { formatDiff } from "./report";
import type { CommandOutcome } from "./check";
import { scanRevision, scanTarget, WORKING_TREE } from "./scan";

export interface DiffArgs {
  root: string;
  base: string;
  /** A revision, or WORKING_TREE for the uncommitted working tree. */
  head: string;
  format: "text" | "json";
}

export async function runDiff(args: DiffArgs): Promise<CommandOutcome> {
  const before = await scanRevision(args.root, args.base);
  const after = await scanTarget(args.root, args.head);

  const diff = diffGraphs(before.graph, after.graph, before.label, after.label);

  const stdout = args.format === "json" ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff);
  return { stdout, exitCode: 0 };
}

export { WORKING_TREE };
