import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  const m = await rejectMessage(diffRevisions(dir, "main"));
  expect(m).toMatch(/Diff of .* failed/);
  // Guidance must be the git/revision one for a genuine revision failure.
  expect(m).toMatch(/needs a git repo and valid revisions/);
});

test("diffRevisions compares a revision against the working tree in a real repo", async () => {
  // The only coverage of the diff pipeline itself: scanRevision + scanTarget +
  // diffGraphs wiring, and the `head ?? WORKING_TREE` default.
  const repo = await mkdtemp(join(tmpdir(), "polygraph-mcp-git-"));
  const git = async (...args: string[]): Promise<void> => {
    const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
    await p.exited;
  };
  try {
    await git("init");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await writeFile(join(repo, "a.ts"), "export function a(): number {\n  return 1;\n}\n");
    await git("add", "-A");
    await git("commit", "-m", "base");

    // Add a second file in the working tree only.
    await writeFile(
      join(repo, "b.ts"),
      'import { a } from "./a";\n\nexport function b(): number {\n  return a();\n}\n',
    );

    clearScanCache();
    const r = await diffRevisions(repo, "HEAD");
    expect(r.head).toBe("working tree"); // the omitted-head default
    expect(r.summary.nodesAdded).toBeGreaterThan(0);
    expect(r.addedNodes.some((n) => n.filePath.endsWith("b.ts"))).toBe(true);
    expect(r.blastRadiusTotal).toBeGreaterThanOrEqual(r.blastRadius.length);
  } finally {
    clearScanCache();
    await rm(repo, { recursive: true, force: true });
  }
}, 60_000);

test("readSource reads a scanned file and honors a line range", async () => {
  const whole = await readSource(dir, "a.ts");
  expect(whole.content).toContain("import { b }");
  expect(whole.totalLines).toBeGreaterThan(1);

  const firstLine = await readSource(dir, "a.ts", 1, 1);
  expect(firstLine.startLine).toBe(1);
  expect(firstLine.endLine).toBe(1);
  expect(firstLine.content).toBe('import { b } from "./b";');
});

// Gate 1 of readSource: graph membership. "../cache.ts" is rejected here and never
// reaches the realpath containment check — the test below covers that separately.
test("readSource refuses a file that isn't in the scanned graph", async () => {
  expect(await rejectMessage(readSource(dir, "../cache.ts"))).toMatch(/not a scanned source file/);
});

// Gate 2: realpath containment. This pins `realpath(root)` on the LEFT of the
// comparison — drop it and every read under a symlinked root breaks, a regression
// nothing else here would catch.
test("readSource reads through a symlinked root (realpath applies to both sides)", async () => {
  const real = await mkdtemp(join(tmpdir(), "polygraph-mcp-real-"));
  const linkDir = await mkdtemp(join(tmpdir(), "polygraph-mcp-link-"));
  const link = join(linkDir, "root");
  await writeFile(join(real, "s.ts"), "export const s = 1;\n");
  try {
    await symlink(real, link, "junction");
  } catch {
    return; // Windows without Developer Mode / elevated rights: skip, don't fail.
  }
  try {
    clearScanCache();
    const r = await readSource(link, "s.ts");
    expect(r.content).toContain("export const s");
  } finally {
    clearScanCache();
    await rm(linkDir, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  }
});

test("readSource counts lines without the trailing newline artifact, and rejects an inverted range", async () => {
  // Its own fixture dir: adding a file to the shared one would change the node
  // counts other tests assert.
  const d2 = await mkdtemp(join(tmpdir(), "polygraph-mcp-lines-"));
  try {
    // 4 real lines, newline-terminated: split("\n") alone would report 5.
    await writeFile(
      join(d2, "four.ts"),
      "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
    );
    clearScanCache();
    const r = await readSource(d2, "four.ts");
    expect(r.totalLines).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.content.split("\n").length).toBe(4);

    expect(await rejectMessage(readSource(d2, "four.ts", 3, 1))).toMatch(/Invalid line range/);
  } finally {
    clearScanCache();
    await rm(d2, { recursive: true, force: true });
  }
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

test("checkRules emits SARIF only when asked, carrying every violation", async () => {
  // A rule that the fixture actually violates (a.ts imports b.ts). Asserting against
  // an empty log would still pass if SARIF conversion dropped every result — which is
  // the bug that matters, since a zero-result upload reads as "clean" in CI.
  const cfg = join(dir, "sarif.polygraph.yml");
  await writeFile(
    cfg,
    "rules:\n  - name: no-a-to-b\n    severity: error\n    from:\n      path: '**/a.ts'\n    disallow:\n      path: '**/b.ts'\n",
  );
  const plain = await checkRules(dir, cfg);
  expect(plain.sarif).toBeUndefined();
  expect(plain.total).toBeGreaterThan(0); // the config must actually bite

  const sarif = await checkRules(dir, cfg, "sarif");
  expect(typeof sarif.sarif).toBe("string");
  const log = JSON.parse(sarif.sarif!);
  expect(log.version).toBe("2.1.0");
  // Every violation survives the conversion, with its location.
  expect(log.runs[0].results.length).toBe(plain.total);
  expect(log.runs[0].results[0].ruleId).toBe("no-a-to-b");
  expect(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBeTruthy();
});
