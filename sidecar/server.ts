// PolyGraph analysis sidecar: a tiny Bun HTTP server hosting the scan/analyze
// handlers over loopback. Run directly in dev or compiled to a standalone binary
// with `bun build --compile` for the Tauri bundle. Binds 127.0.0.1 only (no
// firewall prompt) and prints the chosen port so the Tauri Rust core can read it.

import { SCAN_NDJSON_CONTENT_TYPE, scanNdjsonStream } from "../lib/graph/scan-ndjson";
import type { SourceFileMap } from "../lib/graph/types";
import { runAnalyze, runScan } from "../lib/server/handlers";
import { exitWhenOrphaned } from "./orphan-watch";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch (err) {
    // A graph large enough to overflow V8's ~512MB string ceiling throws here;
    // answer with a clear 507 instead of letting the handler crash the request.
    text = JSON.stringify({
      error: err instanceof Error ? err.message : "Response too large to serialize",
    });
    return new Response(text, {
      status: 507,
      headers: { "content-type": "application/json", ...CORS },
    });
  }
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export interface RunningServer {
  port: number;
  stop: () => void;
}

/** Start the sidecar. port 0 (the default) lets the OS assign a free port. */
export function startServer(port = Number(process.env.POLYGRAPH_PORT) || 0): RunningServer {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const { pathname } = new URL(req.url);

      if (req.method === "GET" && pathname === "/health") return json({ ok: true });

      if (req.method === "POST" && pathname === "/scan") {
        const body = (await req.json().catch(() => ({}))) as { path?: string; force?: boolean };
        const r = await runScan(body.path, { force: body.force });
        if (!r.ok) return json({ error: r.error }, r.status);
        // Stream the graph as NDJSON so a huge codebase never has to be held as one
        // serialized string. The over-size confirmation reply carries no graph, so
        // it stays a small regular JSON response.
        if ("graph" in r.value) {
          return new Response(scanNdjsonStream(r.value), {
            status: 200,
            headers: { "content-type": SCAN_NDJSON_CONTENT_TYPE, ...CORS },
          });
        }
        return json(r.value);
      }

      if (req.method === "POST" && pathname === "/analyze") {
        const body = (await req.json().catch(() => ({}))) as { files?: SourceFileMap };
        const r = await runAnalyze(body.files);
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
      }

      return json({ error: "Not found" }, 404);
    },
  });
  return { port: server.port ?? port, stop: () => server.stop(true) };
}

// Binary entry point: start, then announce the port on stdout for the host.
if (import.meta.main) {
  // Exit if the Tauri app dies without killing us (crash / force-kill), so the
  // sidecar can't outlive its parent and strand memory. See sidecar/orphan-watch.ts.
  exitWhenOrphaned(process.ppid);
  const { port } = startServer();
  console.log(`POLYGRAPH_PORT=${port}`);
}
