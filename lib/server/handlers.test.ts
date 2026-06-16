import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalyze, runScan } from "./handlers";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-scan-"));
  await writeFile(join(dir, "a.ts"), "export function hello() { return 1; }\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("runScan returns a graph for a real directory", async () => {
  const r = await runScan(dir);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.fileCount).toBe(1);
    expect(r.value.root).toBe(dir);
    expect(r.value.graph.nodes.length).toBeGreaterThan(0);
  }
});

test("runScan rejects a blank path", async () => {
  const r = await runScan("   ");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(400);
});

test("runScan reports a missing path", async () => {
  const r = await runScan(join(dir, "does-not-exist"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(400);
});

test("runAnalyze accepts a file map", async () => {
  const r = await runAnalyze({ "a.ts": "export const x = 1;" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.graph.nodes.length).toBeGreaterThan(0);
});

test("runAnalyze rejects a non-object", async () => {
  // @ts-expect-error intentionally wrong type
  const r = await runAnalyze([]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(400);
});
