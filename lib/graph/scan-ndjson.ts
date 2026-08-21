// Streaming codec for the /scan graph result. A whole-codebase graph serialized
// with a single `JSON.stringify` becomes one string that hits V8's ~512MB length
// ceiling and hard-fails on very large scans (e.g. the full Linux kernel). NDJSON
// sidesteps that on both ends: the server emits one JSON object per line through a
// ReadableStream (never holding the whole serialized payload), and the client
// reads it incrementally (never building the giant intermediate string before a
// single `JSON.parse`). The graph still has to fit in memory as objects — this
// raises the serialize/parse ceiling, it doesn't make the graph free.
//
// Wire format (line-delimited JSON, "\n" after every line):
//   line 0:      {"meta": ScanMeta}   — counts + the small side-data
//   next N lines: a GraphNode each     (N === meta.nodeCount)
//   next M lines: a GraphEdge each     (M === meta.edgeCount)
//
// errors / unresolved / manifests ride inside the meta line: they're far smaller
// than the node/edge set, so a single stringify of them stays well under the
// ceiling. (If unresolved ever dominates on a huge repo, stream it too.)

import type { CatalogWarning, DimensionCatalog } from "./dimensions";
import type { PackageManifest } from "./levels/types";
import type { AnalyzeError, GraphEdge, GraphNode, UnresolvedRef } from "./types";

export const SCAN_NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** The full scan result the codec round-trips. Structurally matches ScanData. */
export interface ScanPayload {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  errors: AnalyzeError[];
  unresolved: UnresolvedRef[];
  fileCount: number;
  skipped: number;
  root: string;
  manifests: PackageManifest[];
  /** The merged multi-language dimension catalog; rides in the meta line (small). */
  dimensions?: DimensionCatalog;
  catalogWarnings?: CatalogWarning[];
  /** Optional engine timings (ms); present on a server scan, absent in tests/CLI. */
  timings?: { scanMs: number; analyzeMs: number };
}

interface ScanMeta {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  skipped: number;
  root: string;
  errors: AnalyzeError[];
  unresolved: UnresolvedRef[];
  manifests: PackageManifest[];
  dimensions?: DimensionCatalog;
  catalogWarnings?: CatalogWarning[];
  timings?: { scanMs: number; analyzeMs: number };
}

/** Lazily yield each NDJSON line (meta, then nodes, then edges). */
export function* scanNdjsonLines(value: ScanPayload): Generator<string> {
  const { graph, errors, unresolved, fileCount, skipped, root, manifests, timings } = value;
  const meta: ScanMeta = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    fileCount,
    skipped,
    root,
    errors,
    unresolved,
    manifests,
    ...(value.dimensions ? { dimensions: value.dimensions } : {}),
    ...(value.catalogWarnings ? { catalogWarnings: value.catalogWarnings } : {}),
    ...(timings ? { timings } : {}),
  };
  yield `${JSON.stringify({ meta })}\n`;
  for (const n of graph.nodes) yield `${JSON.stringify(n)}\n`;
  for (const e of graph.edges) yield `${JSON.stringify(e)}\n`;
}

/**
 * Stream the payload as NDJSON bytes. Lines are batched per pull so a multi-
 * million-line graph doesn't cost one stream callback per object, while peak
 * memory stays bounded to a batch rather than the whole serialized graph.
 */
export function scanNdjsonStream(
  value: ScanPayload,
  linesPerChunk = 512,
): ReadableStream<Uint8Array> {
  const it = scanNdjsonLines(value);
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      let chunk = "";
      for (let i = 0; i < linesPerChunk; i++) {
        const next = it.next();
        if (next.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          controller.close();
          return;
        }
        chunk += next.value;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

/** Read an NDJSON scan response back into a ScanPayload. */
export async function readScanNdjson(res: Response): Promise<ScanPayload> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Scan response has no readable body");

  const decoder = new TextDecoder();
  let buf = "";
  let meta: ScanMeta | null = null;
  let seen = 0;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const consume = (line: string) => {
    if (!line) return;
    if (meta === null) {
      meta = (JSON.parse(line) as { meta: ScanMeta }).meta;
      return;
    }
    if (seen < meta.nodeCount) nodes.push(JSON.parse(line) as GraphNode);
    else edges.push(JSON.parse(line) as GraphEdge);
    seen++;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      consume(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf) consume(buf); // trailing line with no final newline

  if (!meta) throw new Error("Malformed scan stream: missing header");
  const m: ScanMeta = meta;
  return {
    graph: { nodes, edges },
    errors: m.errors,
    unresolved: m.unresolved,
    fileCount: m.fileCount,
    skipped: m.skipped,
    root: m.root,
    manifests: m.manifests,
    ...(m.dimensions ? { dimensions: m.dimensions } : {}),
    ...(m.catalogWarnings ? { catalogWarnings: m.catalogWarnings } : {}),
    ...(m.timings ? { timings: m.timings } : {}),
  };
}
