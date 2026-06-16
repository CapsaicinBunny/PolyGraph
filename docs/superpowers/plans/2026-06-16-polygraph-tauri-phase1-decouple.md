# PolyGraph Tauri — Phase 1: Decouple analysis into a Bun sidecar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move scan/analyze out of Next.js API routes into a standalone Bun HTTP sidecar that the web client (and, in later phases, the Tauri webview) talks to over loopback, and switch the Next app to a static export — without changing any analysis behavior.

**Architecture:** Extract the two route handler bodies into framework-agnostic `lib/server/handlers.ts`. A Bun server (`sidecar/server.ts`) hosts `/scan`, `/analyze`, `/health` over `127.0.0.1`. The client resolves the sidecar base URL via `lib/client/api.ts` (an injected global in the app, a fixed dev port otherwise). The Next config becomes `output: "export"` and the `app/api/*` routes are deleted, so there is one analysis code path. Server-side scan now runs the full multi-language kernel (`analyzeProject`), not just TS — a correctness improvement the sidecar inherits.

**Tech Stack:** Bun 1.3.14 (`Bun.serve`, `bun build --compile`), Next.js 15.5 static export, TypeScript, `bun test`, GitHub Actions.

---

## File structure

**Create:**
- `lib/server/handlers.ts` — `runScan(path)` / `runAnalyze(files)`, framework-agnostic, return a discriminated `Handled<T>`.
- `lib/server/handlers.test.ts` — unit tests for both handlers against a temp fixture dir.
- `sidecar/server.ts` — Bun HTTP server exposing the handlers; `startServer()` is exported for tests, and runs on import as the binary entry point.
- `sidecar/server.test.ts` — integration smoke test (start server, hit `/health`, `/scan`, `/analyze`).
- `lib/client/api.ts` — `apiBase()` sidecar URL resolver.
- `lib/client/env.ts` — `isTauri()`.
- `lib/client/api.test.ts` — tests for `apiBase()` / `isTauri()`.
- `scripts/dev.mjs` — runs `next dev` + the sidecar together.
- `.github/workflows/ci.yml` — typecheck/lint/format/test + sidecar & web build on push/PR.

**Modify:**
- `lib/kernel/treesitter/core.ts` — honor `POLYGRAPH_CORE` env for the addon path (so a bundled `.node` can be located outside the repo).
- `components/UploadDropzone.tsx` — route the two `fetch` calls through `apiBase()`.
- `next.config.mjs` — `output: "export"`; drop the now-unused server-bundle note.
- `package.json` — `dev`, `dev:next`, `dev:sidecar`, `build:sidecar` scripts.
- `docs/ARCHITECTURE.md` — replace the API-routes description with the sidecar.

**Delete:**
- `app/api/scan/route.ts`, `app/api/analyze/route.ts` (and the now-empty `app/api/` dirs).

---

## Task 1: Make the analyzer-core addon path configurable

**Files:**
- Modify: `lib/kernel/treesitter/core.ts`
- Test: `lib/kernel/treesitter/core.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/kernel/treesitter/core.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCorePath } from "./core";

const original = process.env.POLYGRAPH_CORE;

afterEach(() => {
  if (original === undefined) delete process.env.POLYGRAPH_CORE;
  else process.env.POLYGRAPH_CORE = original;
});

test("uses POLYGRAPH_CORE when set", () => {
  process.env.POLYGRAPH_CORE = "/opt/app/analyzer-core.node";
  expect(resolveCorePath()).toBe("/opt/app/analyzer-core.node");
});

test("falls back to the repo-relative default", () => {
  delete process.env.POLYGRAPH_CORE;
  expect(resolveCorePath()).toBe(
    join(process.cwd(), "analyzer-core", "analyzer-core.node"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/kernel/treesitter/core.test.ts`
Expected: FAIL — `resolveCorePath` is not exported.

- [ ] **Step 3: Implement**

Edit `lib/kernel/treesitter/core.ts`. Add the exported resolver and use it in `loadCore`:

```ts
import { join } from "node:path";

export interface AnalyzerCore {
  /** Returns JSON `{ nodes, edges, errors }` for a bucket of same-language files. */
  analyze(grammar: string, querySrc: string, importStyle: string, filesJson: string): string;
}

/**
 * Absolute path to the native addon. POLYGRAPH_CORE lets a packaged build (the
 * Bun sidecar / Tauri app) point at a bundled .node outside the repo; otherwise
 * it resolves relative to the working directory for local dev and tests.
 */
export function resolveCorePath(): string {
  return process.env.POLYGRAPH_CORE ?? join(process.cwd(), "analyzer-core", "analyzer-core.node");
}

let cached: AnalyzerCore | null = null;

export function loadCore(): AnalyzerCore {
  if (!cached) {
    const mod = { exports: {} as AnalyzerCore };
    process.dlopen(mod, resolveCorePath());
    cached = mod.exports;
  }
  return cached;
}
```

(Keep the existing file-top comment block above the imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/kernel/treesitter/core.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/kernel/treesitter/core.ts lib/kernel/treesitter/core.test.ts
git commit -m "Make analyzer-core addon path overridable via POLYGRAPH_CORE"
```

---

## Task 2: Extract framework-agnostic scan/analyze handlers

**Files:**
- Create: `lib/server/handlers.ts`
- Test: `lib/server/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/server/handlers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/server/handlers.test.ts`
Expected: FAIL — `./handlers` not found.

- [ ] **Step 3: Implement**

Create `lib/server/handlers.ts`:

```ts
// Framework-agnostic analysis entry points shared by the Bun sidecar. These are
// the former Next.js API route bodies, returning plain data + a discriminated
// error instead of an HTTP Response. Scan runs the full multi-language kernel
// (analyzeProject), so a server-side scan now covers every supported language,
// not just TypeScript.

import { stat } from "node:fs/promises";
import type { AnalyzeError, GraphModel, SourceFileMap } from "../graph/types";
import { analyzeProject } from "../kernel";
import { readPackageDeps } from "./package-deps";
import { scanDirectory } from "./scan-dir";

export interface ScanData {
  graph: GraphModel;
  errors: AnalyzeError[];
  fileCount: number;
  skipped: number;
  root: string;
}

export interface AnalyzeData {
  graph: GraphModel;
  errors: AnalyzeError[];
}

export type Handled<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Validate + scan a directory on disk, then analyze it. */
export async function runScan(path: string | undefined): Promise<Handled<ScanData>> {
  const root = path?.trim();
  if (!root) return { ok: false, status: 400, error: "Expected { path: string }" };

  try {
    const info = await stat(root);
    if (!info.isDirectory()) return { ok: false, status: 400, error: `Not a directory: ${root}` };
  } catch {
    return { ok: false, status: 400, error: `Path not found: ${root}` };
  }

  try {
    const { files, skipped } = await scanDirectory(root);
    const fileCount = Object.keys(files).length;
    if (fileCount === 0) {
      return { ok: false, status: 400, error: "No source files found under that path." };
    }
    const packages = await readPackageDeps(root);
    const { graph, errors } = await analyzeProject(files, { packages });
    return { ok: true, value: { graph, errors, fileCount, skipped, root } };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Scan failed" };
  }
}

/** Analyze an in-memory file map (the browser-read fallback path). */
export async function runAnalyze(files: SourceFileMap | undefined): Promise<Handled<AnalyzeData>> {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return { ok: false, status: 400, error: "Expected { files: Record<string, string> }" };
  }
  try {
    const { graph, errors } = await analyzeProject(files);
    return { ok: true, value: { graph, errors } };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Analysis failed" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/server/handlers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/server/handlers.ts lib/server/handlers.test.ts
git commit -m "Extract framework-agnostic scan/analyze handlers (scan now multi-language)"
```

---

## Task 3: Build the Bun sidecar HTTP server

**Files:**
- Create: `sidecar/server.ts`
- Test: `sidecar/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `sidecar/server.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("POST /scan analyzes a directory", async () => {
  const res = await fetch(`${base}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { graph: { nodes: unknown[] }; fileCount: number };
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test sidecar/server.test.ts`
Expected: FAIL — `./server` not found.

- [ ] **Step 3: Implement**

Create `sidecar/server.ts`:

```ts
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
        const body = (await req.json().catch(() => ({}))) as { path?: string };
        const r = await runScan(body.path);
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
  return { port: server.port, stop: () => server.stop(true) };
}

// Binary entry point: start, then announce the port on stdout for the host.
if (import.meta.main) {
  const { port } = startServer();
  console.log(`POLYGRAPH_PORT=${port}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test sidecar/server.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add sidecar/server.ts sidecar/server.test.ts
git commit -m "Add Bun analysis sidecar (scan/analyze/health over loopback)"
```

---

## Task 4: Client sidecar-URL + Tauri-detection helpers

**Files:**
- Create: `lib/client/api.ts`, `lib/client/env.ts`
- Test: `lib/client/api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/client/api.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { apiBase } from "./api";
import { isTauri } from "./env";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("apiBase defaults to the dev sidecar port", () => {
  delete (globalThis as { window?: unknown }).window;
  expect(apiBase()).toBe("http://127.0.0.1:4319");
});

test("apiBase uses the injected app base when present", () => {
  (globalThis as { window?: unknown }).window = { __POLYGRAPH_API__: "http://127.0.0.1:55001" };
  expect(apiBase()).toBe("http://127.0.0.1:55001");
});

test("isTauri is false without the Tauri global", () => {
  (globalThis as { window?: unknown }).window = {};
  expect(isTauri()).toBe(false);
});

test("isTauri is true when the Tauri internals global exists", () => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  expect(isTauri()).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Git/TSModuleScanner && bun test lib/client/api.test.ts`
Expected: FAIL — `./api` / `./env` not found.

- [ ] **Step 3: Implement**

Create `lib/client/api.ts`:

```ts
// Resolves the analysis sidecar base URL. In the Tauri app the Rust core injects
// window.__POLYGRAPH_API__ once the sidecar reports its port; under `next dev`
// the client talks to the fixed dev-sidecar port instead.

const DEV_BASE = "http://127.0.0.1:4319";

declare global {
  interface Window {
    __POLYGRAPH_API__?: string;
  }
}

export function apiBase(): string {
  if (typeof window !== "undefined" && window.__POLYGRAPH_API__) {
    return window.__POLYGRAPH_API__;
  }
  return DEV_BASE;
}
```

Create `lib/client/env.ts`:

```ts
// True when running inside the Tauri webview (v2 exposes __TAURI_INTERNALS__).
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/Git/TSModuleScanner && bun test lib/client/api.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add lib/client/api.ts lib/client/env.ts lib/client/api.test.ts
git commit -m "Add client sidecar-URL and Tauri-detection helpers"
```

---

## Task 5: Point the client fetches at the sidecar

**Files:**
- Modify: `components/UploadDropzone.tsx`

- [ ] **Step 1: Add the import**

In `components/UploadDropzone.tsx`, add to the local imports (just after the `read-files` import on line 20):

```ts
import { apiBase } from "@/lib/client/api";
```

- [ ] **Step 2: Update the scan fetch**

Replace the `scan` fetch URL:

```ts
      const res = await fetch(`${apiBase()}/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: trimmed }),
      });
```

(Previously `fetch("/api/scan", …)`.)

- [ ] **Step 3: Update the analyze fetch**

Replace the `analyze` fetch URL:

```ts
      const res = await fetch(`${apiBase()}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
```

(Previously `fetch("/api/analyze", …)`. Leave the surrounding `JSON.stringify` guard intact.)

- [ ] **Step 4: Verify typecheck**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /c/Git/TSModuleScanner
git add components/UploadDropzone.tsx
git commit -m "Route client scan/analyze fetches through the sidecar base URL"
```

---

## Task 6: Delete the Next API routes and switch to static export

**Files:**
- Delete: `app/api/scan/route.ts`, `app/api/analyze/route.ts`
- Modify: `next.config.mjs`

- [ ] **Step 1: Delete the route files and their (now-empty) directories**

```bash
cd /c/Git/TSModuleScanner
git rm app/api/scan/route.ts app/api/analyze/route.ts
```

(If `app/api/` and its subdirs are now empty, `git rm` already removed the tracked files; remove any leftover empty dirs with `rmdir app/api/scan app/api/analyze app/api` — ignore errors if Git already cleared them.)

- [ ] **Step 2: Update `next.config.mjs`**

Replace the whole file with:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // PolyGraph ships as a static SPA inside a Tauri webview; analysis runs in the
  // Bun sidecar, not in Next. Export a static bundle (out/) with no server.
  output: "export",
};

export default nextConfig;
```

- [ ] **Step 3: Build the static export**

Run: `cd /c/Git/TSModuleScanner && bun run build`
Expected: build succeeds and writes an `out/` directory containing `index.html`.

If the build fails complaining about image optimization, add `images: { unoptimized: true }` to `nextConfig` and rebuild. (Not expected — the app uses Chakra `Image`, not `next/image`.)

- [ ] **Step 4: Verify `out/` exists**

Run: `cd /c/Git/TSModuleScanner && ls out/index.html`
Expected: the path prints (file exists).

- [ ] **Step 5: Ignore the build output and commit**

Confirm `out/` is git-ignored (Next's default `.gitignore` ignores `/out/`; add it if missing):

```bash
cd /c/Git/TSModuleScanner
grep -qxF "/out/" .gitignore || echo "/out/" >> .gitignore
git add next.config.mjs .gitignore
git commit -m "Drop Next API routes; switch to static export (analysis is in the sidecar)"
```

---

## Task 7: Dev orchestration + sidecar build scripts

**Files:**
- Create: `scripts/dev.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/dev.mjs`**

```js
// Dev orchestrator: runs the Next dev server and the analysis sidecar together.
// The sidecar binds the fixed dev port (4319) that lib/client/api.ts targets.
import { spawn } from "node:child_process";

const procs = [
  spawn("bun", ["run", "dev:sidecar"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, POLYGRAPH_PORT: "4319" },
  }),
  spawn("bun", ["run", "dev:next"], { stdio: "inherit", shell: true }),
];

let closing = false;
const shutdown = (code) => {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill();
  process.exit(code ?? 0);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const p of procs) p.on("exit", (code) => shutdown(code));
```

- [ ] **Step 2: Update `package.json` scripts**

Replace the `scripts` block's `dev` line and add the new scripts so the block reads:

```json
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "dev:next": "next dev -p 3003",
    "dev:sidecar": "bun run sidecar/server.ts",
    "build": "next build",
    "build:sidecar": "bun build --compile sidecar/server.ts --outfile dist/polygraph-sidecar",
    "start": "next start",
    "typecheck": "tsgo --noEmit",
    "lint": "oxlint --type-aware",
    "lint:fix": "oxlint --type-aware --fix",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "test": "bun test"
  },
```

(`dev:next` pins port 3003 to avoid the user's app on 3000.)

- [ ] **Step 3: Verify the sidecar build works**

Run: `cd /c/Git/TSModuleScanner && bun run build:sidecar && ls dist/`
Expected: produces `dist/polygraph-sidecar.exe` (Windows) — the path prints.

- [ ] **Step 4: Smoke-test the dev orchestrator**

Run (in a background-capable terminal): `cd /c/Git/TSModuleScanner && bun run dev`
Expected: both processes start; the sidecar logs `POLYGRAPH_PORT=4319` and Next serves on `http://localhost:3003`. Open the app, paste an absolute project path into "Scan a folder", click Scan, and confirm a graph renders. Then stop with Ctrl-C.

- [ ] **Step 5: Ignore `dist/` and commit**

```bash
cd /c/Git/TSModuleScanner
grep -qxF "/dist/" .gitignore || echo "/dist/" >> .gitignore
git add scripts/dev.mjs package.json .gitignore
git commit -m "Add dev orchestrator and sidecar build scripts"
```

---

## Task 8: Continuous integration workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

This runs on `windows-latest` so the committed Windows `analyzer-core.node` loads without a Rust rebuild — keeping CI fast. Per-OS native rebuilds belong to the release workflow (Phase 2/3).

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14

      - name: Install dependencies
        run: bun install

      - name: Typecheck
        run: bun run typecheck

      - name: Lint
        run: bun run lint

      - name: Format check
        run: bun run format:check

      - name: Test
        run: bun test

      - name: Build sidecar
        run: bun run build:sidecar

      - name: Build web (static export)
        run: bun run build
```

- [ ] **Step 2: Commit and push**

```bash
cd /c/Git/TSModuleScanner
git add .github/workflows/ci.yml
git commit -m "Add CI: typecheck, lint, format, test, sidecar + web build"
git push
```

- [ ] **Step 3: Verify CI is green**

Run: `cd /c/Git/TSModuleScanner && gh run watch` (or `gh run list --limit 1`)
Expected: the `check` job completes successfully.

---

## Task 9: Update the architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Replace the input/pipeline description**

In `docs/ARCHITECTURE.md`, update the pipeline step 1 and the project-layout `api/` line to describe the sidecar instead of Next API routes. Change the step-1 bullet (around line 19) to:

```markdown
1. **Input** — the React client sends the folder path (or, on the web fallback, a
   read-in-browser file map) to the **Bun analysis sidecar** (`sidecar/server.ts`),
   a loopback HTTP server hosting `/scan` and `/analyze`. The sidecar calls the
   shared handlers (`lib/server/handlers.ts`); scan reads the path from disk —
   nothing is uploaded.
```

And replace the `app/` block's `api/{scan,analyze}/` line in the project-layout section with:

```markdown
  page.tsx              renders the Explorer (static-exported SPA)
sidecar/server.ts       Bun loopback server hosting /scan and /analyze
lib/server/handlers.ts  framework-agnostic runScan / runAnalyze
```

- [ ] **Step 2: Verify formatting**

Run: `cd /c/Git/TSModuleScanner && bun run format:check`
Expected: no changes needed (or run `bun run format` and re-check).

- [ ] **Step 3: Commit**

```bash
cd /c/Git/TSModuleScanner
git add docs/ARCHITECTURE.md
git commit -m "Docs: describe the analysis sidecar instead of Next API routes"
```

---

## Final verification

- [ ] **Full test suite + checks pass**

Run: `cd /c/Git/TSModuleScanner && bun run typecheck && bun test && bun run lint && bun run format:check`
Expected: typecheck clean; **all tests pass** (71 prior + ~16 new = ~87); lint clean; format clean.

- [ ] **End-to-end smoke (manual)**

Run `bun run dev`, scan a real project folder, confirm a multi-language graph renders (try a repo with non-TS files to confirm scan now covers all languages). Stop the dev processes.

---

## Notes for later phases (do NOT implement here)

- **Phase 2:** `src-tauri/` shell (Tauri v2) — spawn the sidecar via `tauri-plugin-shell`, read `POLYGRAPH_PORT=` from its stdout, inject `window.__POLYGRAPH_API__`; native "Choose folder" via `@tauri-apps/plugin-dialog` gated on `isTauri()`.
  - **Resource bundling (important):** `bun build --compile` bundles JS only, **not** fs-read data. The compiled sidecar therefore won't find the `language-packs/<id>/{pack.yaml,tags.scm}` files or `analyzer-core.node` by their dev paths. Phase 2 must ship both as Tauri resources and teach the sidecar where they live — `POLYGRAPH_CORE` already covers the `.node`; add an equivalent (e.g. `POLYGRAPH_PACKS`) for the packs dir, set by the Rust core to the bundled resource path. (Phase 1 dev runs `bun run sidecar/server.ts`, which reads both from the repo, so this only bites the compiled bundle.)
  - Release workflow builds the per-OS `.node` + compiled sidecar and runs `tauri build`.
- **Phase 3:** extend the release workflow to a macOS + Linux matrix.
- **Phase 4:** Authenticode / Apple notarization / AppImage signing + Tauri updater (needs maintainer-supplied certs as repo secrets).
