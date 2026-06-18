import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScanNdjson } from "../lib/graph/scan-ndjson";
import { startServer, type RunningServer } from "./server";

let server: RunningServer;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-sidecar-"));
  await writeFile(join(dir, "a.ts"), "export function hi() { return 1; }\n");
  server = startServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop();
  await rm(dir, { recursive: true, force: true });
});

test("GET /health returns ok", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("POST /scan streams the graph as NDJSON", async () => {
  const res = await fetch(`${base}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("ndjson");
  const data = await readScanNdjson(res);
  expect(data.fileCount).toBe(1);
  expect(data.graph.nodes.length).toBeGreaterThan(0);
});

test("POST /scan surfaces a bad path as 400", async () => {
  const res = await fetch(`${base}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toHaveProperty("error");
});

test("POST /analyze analyzes a file map", async () => {
  const res = await fetch(`${base}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { "a.ts": "export const x = 1;" } }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { graph: { nodes: unknown[] } };
  expect(data.graph.nodes.length).toBeGreaterThan(0);
});

test("CORS preflight is answered", async () => {
  const res = await fetch(`${base}/scan`, { method: "OPTIONS" });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});
