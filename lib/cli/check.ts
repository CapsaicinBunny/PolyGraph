// `polygraph check` — load .polygraph.yml, scan the working tree, evaluate the
// architecture rules, and report. With --baseline, only violations that aren't
// already present on the baseline revision are reported (and gate the exit code),
// so a team can adopt rules without first fixing every legacy violation.

import { loadConfigFile } from "../config/load";
import { evaluate, fingerprint } from "../rules/engine";
import { toSarifString } from "../rules/sarif";
import { formatCheck } from "./report";
import { scanRevision, scanWorkingTree } from "./scan";

export interface CheckArgs {
  root: string;
  configPath: string;
  format: "text" | "sarif";
  baseline?: string;
}

export interface CommandOutcome {
  stdout: string;
  exitCode: number;
}

export async function runCheck(args: CheckArgs): Promise<CommandOutcome> {
  const config = await loadConfigFile(args.configPath);
  const { graph, fileCount } = await scanWorkingTree(args.root);

  let violations = evaluate(config, graph);

  if (args.baseline) {
    const base = await scanRevision(args.root, args.baseline);
    const baselineFingerprints = new Set(evaluate(config, base.graph).map(fingerprint));
    violations = violations.filter((v) => !baselineFingerprints.has(fingerprint(v)));
  }

  const errorCount = violations.filter((v) => v.severity === "error").length;
  const exitCode = errorCount > 0 ? 1 : 0;

  const stdout =
    args.format === "sarif"
      ? toSarifString(violations)
      : formatCheck(config, violations, {
          root: args.root,
          fileCount,
          baseline: args.baseline,
        });

  return { stdout, exitCode };
}
