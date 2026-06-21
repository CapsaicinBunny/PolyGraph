// Phase D — `runCheck` two-stage-validation integration.
//
// validateConfigAgainstIndex is unit-tested in lib/config/validate.test.ts; this
// file pins its INTEGRATION into `polygraph check`: that a config-validation problem
// at `validation.unknownFacet: error` gates the exit code (1) and surfaces a visible
// `config:` line, that the default `warning` severity does NOT gate (exit 0) while
// still surfacing a line, that a clean in-domain config emits no prefix, and that
// SARIF output stays a pure violation document (no config prefix).
//
// The fixture is a tiny on-disk TS project (the TS provider contributes the
// role/category/env/runtime dimensions), scanned for real through runCheck.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./check";

let dir: string;
const cfgPath = () => join(dir, ".polygraph.yml");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-check-"));
  // Two acyclic source files: no rule below ever fires, so the ONLY stdout content
  // is whatever the config-validation prefix contributes — isolating the integration.
  await writeFile(join(dir, "a.ts"), "import { b } from './b';\nexport const a = b;\n");
  await writeFile(join(dir, "b.ts"), "export const b = 1;\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a config doc to the fixture's .polygraph.yml as JSON (valid YAML). */
async function writeConfig(doc: unknown): Promise<void> {
  await writeFile(cfgPath(), JSON.stringify(doc), "utf8");
}

// A cycle rule whose scope carries an UNKNOWN facet key. The graph is acyclic, so the
// rule yields no violations — the only output is the config-validation problem.
const unknownFacetDoc = (severity: "error" | "warning" | undefined) => ({
  ...(severity ? { validation: { unknownFacet: severity } } : {}),
  rules: [{ name: "no cycles", cycles: "error", scope: { facets: { "go.exported": "true" } } }],
});

test("unknownFacet:error → exit 1 with a config error line", async () => {
  await writeConfig(unknownFacetDoc("error"));
  const { stdout, exitCode } = await runCheck({
    root: dir,
    configPath: cfgPath(),
    format: "text",
  });
  expect(exitCode).toBe(1);
  expect(stdout).toContain("config:");
  expect(stdout).toContain("go.exported");
  // Error marker (✗), not the warning marker (⚠).
  expect(stdout).toContain("✗");
  expect(stdout.startsWith("✗ config:")).toBe(true);
});

test("unknownFacet default (warning) → exit 0 with a warning line", async () => {
  await writeConfig(unknownFacetDoc(undefined));
  const { stdout, exitCode } = await runCheck({
    root: dir,
    configPath: cfgPath(),
    format: "text",
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain("config:");
  expect(stdout).toContain("go.exported");
  expect(stdout).toContain("⚠");
});

test("clean in-domain config → no config prefix, exit 0", async () => {
  // `kind` is a structural dimension (always registered); `file` is in its domain.
  await writeConfig({
    rules: [{ name: "no cycles", cycles: "error", scope: { facets: { kind: ["file"] } } }],
  });
  const { stdout, exitCode } = await runCheck({
    root: dir,
    configPath: cfgPath(),
    format: "text",
  });
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("config:");
});

test("SARIF output omits the config prefix even when a problem exists", async () => {
  await writeConfig(unknownFacetDoc("error"));
  const { stdout, exitCode } = await runCheck({
    root: dir,
    configPath: cfgPath(),
    format: "sarif",
  });
  // The exit code still gates on the config-error severity…
  expect(exitCode).toBe(1);
  // …but the body stays a pure SARIF document (no human `config:` prefix lines).
  expect(stdout).not.toContain("config:");
  expect(stdout).not.toContain("⚠");
  expect(JSON.parse(stdout)).toHaveProperty("runs");
});
