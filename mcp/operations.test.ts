import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "./cache";
import { telemetry } from "./telemetry";
import {
  checkRules,
  diffRevisions,
  impactOf,
  listInsights,
  logs,
  nodeDetail,
  pathBetween,
  queryNodes,
  readSource,
  scanSummary,
} from "./operations";

/** Run a promise expected to reject; return its error message (or "" if it resolved). */
async function rejectMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// A tiny two-file fixture: a.ts imports and calls b.ts. Yields 2 file nodes,
// 2 function nodes, an import edge (a.ts → b.ts) and a call edge (a → b).
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-mcp-"));
  await writeFile(
    join(dir, "a.ts"),
    'import { b } from "./b";\n\nexport function a(): number {\n  return b();\n}\n',
  );
  await writeFile(join(dir, "b.ts"), "export function b(): number {\n  return 1;\n}\n");
  clearScanCache();
});

afterAll(async () => {
  clearScanCache();
  await rm(dir, { recursive: true, force: true });
});

test("scanSummary reports counts and kind histograms", async () => {
  const s = await scanSummary(dir);
  expect(s.fileCount).toBe(2);
  expect(s.nodeKinds.file).toBe(2);
  expect(s.nodeCount).toBeGreaterThanOrEqual(4); // 2 files + 2 functions
  expect(s.edgeKinds.import).toBeGreaterThanOrEqual(1);
});

test("queryNodes finds files and reports an empty query", async () => {
  const files = await queryNodes(dir, "kind:file");
  expect(files.matchCount).toBe(2);
  expect(files.nodes.every((n) => n.kind === "file")).toBe(true);

  const empty = await queryNodes(dir, "");
  expect(empty.empty).toBe(true);
});

test("nodeDetail returns an import dependency for the importing file", async () => {
  const files = await queryNodes(dir, "kind:file");
  const aFile = files.nodes.find((n) => n.filePath.endsWith("a.ts"));
  expect(aFile).toBeDefined();
  const detail = await nodeDetail(dir, aFile!.id);
  expect(detail.node.kind).toBe("file");
  expect(detail.dependencies.some((d) => d.kind === "import")).toBe(true);
});

test("nodeDetail rejects an unknown id with guidance", async () => {
  expect(await rejectMessage(nodeDetail(dir, "nope#missing"))).toMatch(/No node with id/);
});

test("listInsights returns a well-formed list", async () => {
  const r = await listInsights(dir);
  expect(typeof r.total).toBe("number");
  expect(Array.isArray(r.insights)).toBe(true);
});

test("checkRules without a config gives an actionable error", async () => {
  expect(await rejectMessage(checkRules(dir))).toMatch(/Could not load PolyGraph config/);
});

test("diffRevisions outside a git repo gives an actionable error", async () => {
  expect(await rejectMessage(diffRevisions(dir, "main"))).toMatch(
    /Could not read revisions to diff/,
  );
});

test("readSource reads a scanned file and honors a line range", async () => {
  const whole = await readSource(dir, "a.ts");
  expect(whole.content).toContain("import { b }");
  expect(whole.totalLines).toBeGreaterThan(1);

  const firstLine = await readSource(dir, "a.ts", 1, 1);
  expect(firstLine.startLine).toBe(1);
  expect(firstLine.endLine).toBe(1);
  expect(firstLine.content).toBe('import { b } from "./b";');
});

test("readSource refuses a path that isn't a scanned source file (no escaping the root)", async () => {
  expect(await rejectMessage(readSource(dir, "../cache.ts"))).toMatch(/not a scanned source file/);
});

test("logs reads and controls the telemetry bus", () => {
  telemetry.setEnabled(true);
  telemetry.clearAll();
  expect(logs("status").eventCount).toBe(0);

  telemetry.event("analysis", "mcp.test", { ok: 1 });
  const tail = logs("tail");
  expect(tail.eventCount).toBe(1);
  expect(tail.events[0]?.event).toBe("mcp.test"); // no narrowing needed: overloads

  // metrics action surfaces recorded metric series.
  telemetry.metric("mcp.scan.ms", 12);
  const metrics = logs("metrics");
  expect(metrics.metrics.histograms["mcp.scan.ms"]?.count).toBe(1);
  expect(metrics.metrics.histograms["mcp.scan.ms"]?.max).toBe(12);

  // tail honors `limit` and returns the most recent events, in order.
  telemetry.clearAll();
  telemetry.event("analysis", "mcp.a");
  telemetry.event("analysis", "mcp.b");
  telemetry.event("analysis", "mcp.c");
  expect(logs("tail", 2).events.map((e) => e.event)).toEqual(["mcp.b", "mcp.c"]);

  expect(logs("disable").enabled).toBe(false);
  expect(logs("enable").enabled).toBe(true);
  expect(logs("clear").eventCount).toBe(0);
});

test("queryNodes pages with offset and reports hasMore", async () => {
  const all = await queryNodes(dir, "kind:file");
  expect(all.matchCount).toBe(2);
  expect(all.offset).toBe(0);
  expect(all.hasMore).toBe(false);

  const first = await queryNodes(dir, "kind:file", 1, 0);
  const second = await queryNodes(dir, "kind:file", 1, 1);
  expect(first.returned).toBe(1);
  expect(first.hasMore).toBe(true); // a second page exists
  expect(second.returned).toBe(1);
  expect(second.offset).toBe(1);
  expect(second.hasMore).toBe(false); // last page
  // Pages must not overlap — the bug an unstable iteration order would cause.
  expect(first.nodes[0]!.id).not.toBe(second.nodes[0]!.id);
  // Together they cover the whole match set.
  expect([first.nodes[0]!.id, second.nodes[0]!.id].sort()).toEqual(
    all.nodes.map((n) => n.id).sort(),
  );

  // An offset past the end is empty, not an error.
  const past = await queryNodes(dir, "kind:file", 10, 99);
  expect(past.returned).toBe(0);
  expect(past.hasMore).toBe(false);
});

test("impactOf reports transitive dependents of a hub", async () => {
  // b.ts is imported+called by a.ts, so changing it affects a.ts and a().
  const r = await impactOf(dir, "b.ts");
  expect(r.label).toBe("b.ts");
  expect(r.total).toBeGreaterThan(0);
  expect(Object.keys(r.byKind).length).toBeGreaterThan(0);
  expect(r.topFiles.some((f) => f.file.endsWith("a.ts"))).toBe(true);
});

test("impactOf rejects an unknown id with guidance", async () => {
  expect(await rejectMessage(impactOf(dir, "nope.ts"))).toMatch(/No node with id/);
});

test("pathBetween finds a directed path and its edges", async () => {
  const r = await pathBetween(dir, "a.ts", "b.ts");
  expect(r.connected).toBe(true);
  expect(r.hops).toBe(1);
  expect(r.path.map((p) => p.id)).toEqual(["a.ts", "b.ts"]);
  expect(r.edges[0]).toMatchObject({ source: "a.ts", target: "b.ts", kind: "import" });
});

test("pathBetween reports no connection in the unreachable direction", async () => {
  // b.ts does not depend on a.ts — the reverse direction has no path.
  const r = await pathBetween(dir, "b.ts", "a.ts");
  expect(r.connected).toBe(false);
  expect(r.path).toEqual([]);
});

test("checkRules emits SARIF only when asked", async () => {
  const cfg = join(dir, "sarif.polygraph.yml");
  await writeFile(cfg, "rules: []\nthresholds:\n  maxFanOut: 1\n  severity: warning\n");
  const plain = await checkRules(dir, cfg);
  expect(plain.sarif).toBeUndefined();
  const sarif = await checkRules(dir, cfg, "sarif");
  expect(typeof sarif.sarif).toBe("string");
  expect(JSON.parse(sarif.sarif!).version).toBe("2.1.0");
});
