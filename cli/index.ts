#!/usr/bin/env bun
// PolyGraph CLI entry point. Turns the analyzer into an architectural guardrail
// (`check`) that teams can run in CI.
//
//   polygraph check .                     evaluate .polygraph.yml against the tree
//   polygraph check . --format sarif      emit SARIF 2.1.0 for code scanning
//   polygraph check . --baseline main     only fail on violations new vs. main

import { resolve } from "node:path";
import { parseArgs } from "../lib/cli/args";
import { runCheck } from "../lib/cli/check";
import { DEFAULT_CONFIG_FILENAME } from "../lib/config/load";

const VERSION = "0.1.0";

const USAGE = `polygraph ${VERSION}

Usage:
  polygraph check [path] [options]      Check architecture rules (.polygraph.yml)

check options:
  --config <file>     Config file (default: <path>/${DEFAULT_CONFIG_FILENAME})
  --format <fmt>      text | sarif (default: text)
  --baseline <rev>    Only report violations new vs. this git revision

Exit codes:
  check  1 if any error-severity violation, else 0
`;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid --format "${value}". Expected: ${allowed.join(" | ")}`);
  }
  return value as T;
}

async function main(): Promise<number> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const root = resolve(positionals[1] ?? ".");

  if (command === "check") {
    const outcome = await runCheck({
      root,
      configPath: flags.config ?? resolve(root, DEFAULT_CONFIG_FILENAME),
      format: oneOf(flags.format, ["text", "sarif"] as const, "text"),
      baseline: flags.baseline,
    });
    process.stdout.write(outcome.stdout);
    return outcome.exitCode;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`polygraph: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
