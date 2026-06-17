// PolyGraph analysis sidecar: a tiny Bun HTTP server hosting the scan/analyze
// handlers over loopback. Run directly in dev or compiled to a standalone binary
// with `bun build --compile` for the Tauri bundle. Binds 127.0.0.1 only (no
// firewall prompt) and prints the chosen port so the Tauri Rust core can read it.

import type { SourceFileMap } from "../lib/graph/types";
import { runAnalyze, runScan } from "../lib/server/handlers";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
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
        return r.ok ? json(r.value) : json({ error: r.error }, r.status);
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
  const { port } = startServer();
  console.log(`POLYGRAPH_PORT=${port}`);
}
