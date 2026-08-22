// Round-trip every tool through a real MCP Client over InMemoryTransport.
//
// This is the layer mcp/operations.test.ts cannot reach: those tests call the ops
// functions directly, so they never see the zod `outputSchema`. That matters because
// the SDK CLIENT validates `structuredContent` against the schema the server
// publishes — a field present in the result but missing from the schema is a hard
// client-side rejection, even though the server's own parse silently strips it and
// looks healthy. Exactly that shipped once (GraphNode.facets vs. the fullNode
// schema), so these tests exist to make schema drift fail here rather than in a host.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearScanCache } from "./cache";
import { createServer } from "./server";

let dir: string;
let client: Client;

/** Call a tool and fail loudly with the server's message if it errored. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
  if (res.isError) {
    throw new Error(`${name} returned isError: ${res.content?.[0]?.text ?? "(no text)"}`);
  }
  expect(res.structuredContent).toBeDefined();
  return res.structuredContent as Record<string, unknown>;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-mcp-server-"));
  // A "use client" React component: this is what materializes GraphNode.facets
  // (env/category/role). The plain-TypeScript eval fixture never produces a faceted
  // node, which is why it could not catch the schema gap.
  await writeFile(
    join(dir, "Widget.tsx"),
    '"use client";\nimport { load } from "./db";\n\nexport function Widget(): string {\n  return load();\n}\n',
  );
  await writeFile(join(dir, "db.ts"), 'export function load(): string {\n  return "x";\n}\n');

  clearScanCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  // Populate the client's schema cache — validation of structuredContent only kicks
  // in once the client has seen the tool list, same as a real host.
  await client.listTools();
});

afterAll(async () => {
  await client.close();
  clearScanCache();
  await rm(dir, { recursive: true, force: true });
});

test("every registered tool round-trips through a validating client", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "polygraph_check",
    "polygraph_diff",
    "polygraph_impact",
    "polygraph_insights",
    "polygraph_logs",
    "polygraph_node",
    "polygraph_path",
    "polygraph_query",
    "polygraph_read",
    "polygraph_scan",
  ]);

  const scan = await call("polygraph_scan", { path: dir });
  expect(scan.nodeCount).toBeGreaterThan(0);
  expect(typeof scan.scannedAt).toBe("number");

  const q = await call("polygraph_query", { path: dir, query: "kind:file" });
  expect(q.matchCount).toBe(2);

  await call("polygraph_insights", { path: dir });
  await call("polygraph_read", { path: dir, file: "db.ts" });
  await call("polygraph_impact", { path: dir, id: "db.ts" });
  await call("polygraph_path", { path: dir, from: "Widget.tsx", to: "db.ts" });
  for (const action of ["tail", "metrics", "status"]) {
    await call("polygraph_logs", { action });
  }
});

test("polygraph_node validates for a faceted node (regression: GraphNode.facets)", async () => {
  // Widget.tsx carries facets via the "use client" directive. Before `facets` was
  // added to the fullNode schema this call failed client-side with
  // -32602 "data/node must NOT have additional properties".
  const r = await call("polygraph_node", { path: dir, id: "Widget.tsx" });
  const node = r.node as { facets?: Record<string, string[]> };
  expect(node.facets).toBeDefined();
  expect(Object.keys(node.facets ?? {}).length).toBeGreaterThan(0);

  // And a plain node (no facets) still round-trips.
  await call("polygraph_node", { path: dir, id: "db.ts" });
});

test("an invalid query field is reported, not silently answered as zero matches", async () => {
  const r = await call("polygraph_query", { path: dir, query: "bogusfield:x" });
  expect(r.unknownFields).toEqual(["bogusfield"]);

  // A valid query carries no such warning.
  const ok = await call("polygraph_query", { path: dir, query: "kind:file" });
  expect(ok.unknownFields).toBeUndefined();
});

test("a failing tool reports isError with the server's own message", async () => {
  const res = (await client.callTool({
    name: "polygraph_node",
    arguments: { path: dir, id: "does-not-exist.ts" },
  })) as { isError?: boolean; content?: { text?: string }[] };
  expect(res.isError).toBe(true);
  expect(res.content?.[0]?.text).toMatch(/No node with id/);
});

test("the scan widget is registered as a readable resource", async () => {
  const uris = (await client.listResources()).resources.map((r) => r.uri);
  expect(uris).toContain("ui://polygraph/scan-widget");

  const read = await client.readResource({ uri: "ui://polygraph/scan-widget" });
  const first = read.contents[0] as { mimeType?: string; text?: string };
  expect(first.mimeType).toBe("text/html");
  expect(first.text).toContain("<!doctype html>");
});
