import { describe, expect, test } from "bun:test";
import {
  type ScanPayload,
  SCAN_NDJSON_CONTENT_TYPE,
  readScanNdjson,
  scanNdjsonLines,
  scanNdjsonStream,
} from "./scan-ndjson";
import { makeEdge } from "./types";

function sample(): ScanPayload {
  const node = (id: string): ScanPayload["graph"]["nodes"][number] => ({
    id,
    kind: "file",
    label: id,
    filePath: id,
    line: 0,
    parentFile: id,
  });
  return {
    graph: {
      nodes: [node("a.ts"), node("b.ts"), node("c.ts")],
      edges: [
        makeEdge("a.ts", "b.ts", "import", [
          { filePath: "a.ts", line: 1, provider: "TypeScript", confidence: "exact" },
        ]),
        makeEdge("b.ts", "c.ts", "import", [
          { filePath: "b.ts", line: 2, provider: "TypeScript", confidence: "exact" },
        ]),
      ],
    },
    errors: [{ filePath: "x.ts", message: "boom" }],
    unresolved: [],
    fileCount: 3,
    skipped: 1,
    root: "/proj",
    manifests: [],
  };
}

function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { headers: { "content-type": SCAN_NDJSON_CONTENT_TYPE } });
}

/** A stream that emits `text` in fixed-size byte slices, to exercise line buffering. */
function chunkedStream(text: string, bytesPerChunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + bytesPerChunk));
      offset += bytesPerChunk;
    },
  });
}

describe("scan-ndjson codec", () => {
  test("round-trips a payload through the stream", async () => {
    const payload = sample();
    const out = await readScanNdjson(ndjsonResponse(scanNdjsonStream(payload)));
    expect(out).toEqual(payload);
  });

  test("reassembles lines split across chunk boundaries", async () => {
    const payload = sample();
    const text = [...scanNdjsonLines(payload)].join("");
    // 1 byte at a time guarantees every line is split mid-token.
    const out = await readScanNdjson(ndjsonResponse(chunkedStream(text, 1)));
    expect(out).toEqual(payload);
  });

  test("emits exactly one header line plus one line per node and edge", () => {
    const payload = sample();
    const lines = [...scanNdjsonLines(payload)];
    expect(lines.length).toBe(1 + payload.graph.nodes.length + payload.graph.edges.length);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    const meta = (JSON.parse(lines[0]!) as { meta: { nodeCount: number; edgeCount: number } }).meta;
    expect(meta.nodeCount).toBe(payload.graph.nodes.length);
    expect(meta.edgeCount).toBe(payload.graph.edges.length);
  });

  test("rejects a body with no header", async () => {
    const empty = new Response(chunkedStream("", 4), {
      headers: { "content-type": SCAN_NDJSON_CONTENT_TYPE },
    });
    let message = "";
    try {
      await readScanNdjson(empty);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/missing header/);
  });
});
