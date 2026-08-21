// `polygraph check` — load .polygraph.yml, scan the working tree, evaluate the
// architecture rules, and report. With --baseline, only violations that aren't
// already present on the baseline revision are reported (and gate the exit code),
// so a team can adopt rules without first fixing every legacy violation.

import { loadConfigFile, validateConfigAgainstIndex } from "../config/load";
import { clientCatalog } from "../graph/client-catalog";
import { buildDimensionIndex } from "../graph/dimension-index";
import { evaluate, fingerprint } from "../rules/engine";
import { toSarifString } from "../rules/sarif";
import { CROSS, formatCheck, WARN } from "./report";
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
  const { graph, fileCount, dimensions } = await scanWorkingTree(args.root);

  // POST-analysis validation: check selector facets against the built registry.
  // A facet key/value the graph's providers don't supply is reported at the
  // configured severity (default warning); errors gate the exit code.
  const index = buildDimensionIndex(graph, clientCatalog(dimensions));
  const configProblems = validateConfigAgainstIndex(config, index);

  let violations = evaluate(config, graph);

  if (args.baseline) {
    const base = await scanRevision(args.root, args.baseline);
    const baselineFingerprints = new Set(evaluate(config, base.graph).map(fingerprint));
    violations = violations.filter((v) => !baselineFingerprints.has(fingerprint(v)));
  }

  const errorCount =
    violations.filter((v) => v.severity === "error").length +
    configProblems.filter((p) => p.severity === "error").length;
  const exitCode = errorCount > 0 ? 1 : 0;

  const body =
    args.format === "sarif"
      ? toSarifString(violations)
      : formatCheck(config, violations, {
          root: args.root,
          fileCount,
          baseline: args.baseline,
        });

  // Surface config-validation problems (text mode only — SARIF stays a pure
  // violation document) ahead of the report so they aren't lost below a long list.
  const prefix =
    args.format !== "sarif" && configProblems.length > 0
      ? `${configProblems.map((p) => `${p.severity === "error" ? CROSS : WARN} config: ${p.where}: ${p.message}`).join("\n")}\n\n`
      : "";

  return { stdout: prefix + body, exitCode };
}
