import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetry } from "../lib/telemetry";
import { clearScanCache } from "./cache";
import {
  checkRules,
  diffRevisions,
  listInsights,
  logs,
  nodeDetail,
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
  expect(await rejectMessage(diffRevisions(dir, "main"))).toMatch(/Could not diff/);
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
  expect(tail.events?.[0]?.event).toBe("mcp.test");

  expect(logs("disable").enabled).toBe(false);
  expect(logs("enable").enabled).toBe(true);
  expect(logs("clear").eventCount).toBe(0);
});
