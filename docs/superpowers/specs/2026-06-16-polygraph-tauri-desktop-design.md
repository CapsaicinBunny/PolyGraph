# PolyGraph — Tauri Desktop App

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation

## Goal

Ship PolyGraph as a signed, auto-updating desktop app for **Windows, macOS, and
Linux**, built and released **entirely on GitHub Actions** (no local desktop
builds — the maintainer is on Windows and the release is cross-platform).

Keep full analysis fidelity: the precise **ts-morph** TS/JS provider and all 26
tree-sitter language packs must work exactly as they do in the web app.

## Why Tauri changes the input story

The web app's pain points all stem from the browser sandbox: the
`webkitdirectory` popup, no exposed folder path, `NotReadableError` on large
folders, and `RangeError: Invalid string length` when serializing a huge file
map. Tauri provides a **native folder-picker dialog** that returns a real
absolute path. In the desktop app the primary flow becomes:

```
Choose folder → native dialog → absolute path → POST /scan → server reads disk
```

File contents never enter the webview, so the string-size ceiling and handle
exhaustion simply cannot occur — even on a 91k-file project. The browser
drag/drop reader is retained only as a web-mode fallback.

## Constraint: ts-morph forces a JS runtime

ts-morph wraps the TypeScript compiler (JavaScript). Keeping type-resolved call
edges, JSX component/renders detection, framework/paradigm roles, and JSDoc
nodes means shipping a JS runtime inside the app. The 26 tree-sitter grammars
are already native Rust (`analyzer-core`), so the JS runtime is the _only_
reason a sidecar exists. We compile that runtime into a single self-contained
binary with `bun build --compile` (Approach A).

## Architecture

```
┌─ Tauri (Rust core) ─────────────────────────────────┐
│  webview (static Next export → out/)                 │
│     │  fetch  http://127.0.0.1:<port>/scan|/analyze  │
│     ▼                                                │
│  Bun sidecar (compiled binary, externalBin)          │
│     ├ POST /scan    { path }       → GraphModel       │
│     └ POST /analyze { files }      → GraphModel       │
│     loads analyzer-core.node by absolute path         │
│  native folder dialog → absolute path → webview       │
└───────────────────────────────────────────────────────┘
```

Transport: the sidecar binds **127.0.0.1 on an OS-assigned port** (loopback only
→ no OS firewall prompt) and prints `POLYGRAPH_PORT=<n>` on stdout. The Rust core
reads that line, then exposes the base URL to the webview by injecting
`window.__POLYGRAPH_API__` at startup. The client falls back to a fixed dev port
when not running inside Tauri.

## Components

### 1. Shared handlers — `lib/server/handlers.ts`

Extract the bodies of the current `app/api/scan/route.ts` and
`app/api/analyze/route.ts` into framework-agnostic functions:

- `runScan(path: string): Promise<ScanResult>` — stat/validate the dir, walk it,
  read package deps, run `analyzeSources`.
- `runAnalyze(files: SourceFileMap): Promise<AnalyzeResult>` — run the kernel.

These return plain data + a discriminated error (no `NextResponse`). This is the
only meaningful logic move; everything under `lib/` is otherwise untouched, so
the 71 existing tests stay green.

### 2. Sidecar — `sidecar/server.ts`

A Bun HTTP server using these handlers:

- Binds `127.0.0.1:0`, prints `POLYGRAPH_PORT=<n>`, flushes stdout.
- Routes `POST /scan`, `POST /analyze`, and `GET /health`.
- Resolves `analyzer-core.node` from `POLYGRAPH_CORE` env (set by the Rust core
  to the bundled resource path) or a dev-relative default. The existing
  `process.dlopen`-by-absolute-path loader already supports this.
- Returns JSON errors with the same shape the client expects today.

Built per-OS in CI: `bun build --compile --target=bun-<os>-<arch>
sidecar/server.ts --outfile polygraph-sidecar[.exe]`.

### 3. Client — `app/`, `components/`

- `next.config` → `output: "export"`.
- **Remove `app/api/scan` and `app/api/analyze`.** Dev and production both hit
  the sidecar, so there is one analysis code path and static export has no
  dynamic route handlers to choke on.
- `lib/client/api.ts` — resolves the sidecar base URL: `window.__POLYGRAPH_API__`
  in the app, `http://127.0.0.1:<DEV_PORT>` under `next dev`. All fetches use it.
- `lib/client/env.ts` — `isTauri()` via presence of the Tauri global.
- `UploadDropzone` — in Tauri, the primary action is **"Choose folder"** using
  `@tauri-apps/plugin-dialog` `open({ directory: true })`; the returned absolute
  path is POSTed to `/scan`. The browser drag/drop reader remains the web
  fallback (gated on `!isTauri()`).

### 4. Tauri shell — `src-tauri/`

- `main.rs`: spawn the sidecar via `tauri-plugin-shell` sidecar API, read stdout
  until the `POLYGRAPH_PORT=` line, store the base URL, inject it into the
  webview; surface a native error dialog if the sidecar fails to start; ensure
  the sidecar is killed on app exit.
- `tauri.conf.json`: `frontendDist → ../out`; the sidecar as `externalBin`;
  `analyzer-core.node` (and the Vello `.wasm`, if not already emitted into
  `out/`) as bundled `resources`; updater endpoint + per-OS signing config.

### 5. CI — `.github/workflows/release.yml`

Matrix over `windows-latest`, `macos-latest`, `ubuntu-latest`. Each runner:

1. Install Rust + Bun + Node.
2. Build `analyzer-core` → `.node` (`napi build --release`).
3. `bun build --compile` the sidecar for that OS/arch.
4. `next build` (static export → `out/`).
5. `tauri build` → installer(s).
6. Sign (Phase 4) and upload artifacts to a GitHub Release + write the updater
   manifest.

A lighter `ci.yml` (push/PR) runs `typecheck`, `lint`, `format:check`,
`bun test`, the sidecar build, and `next build` on `ubuntu-latest` to keep the
decoupled core honest without doing full Tauri bundling on every push.

## Data flow (desktop)

1. User clicks **Choose folder** → native dialog → absolute path.
2. `fetch(`${base}/scan`, { path })` → sidecar `runScan`.
3. Sidecar reads disk, runs `analyzeSources` (+ kernel), returns `GraphModel`.
4. Webview renders via the existing aggregate → layout → Vello pipeline.

`/analyze` (raw file map) remains available for the web fallback only.

## Error handling

- **Sidecar won't start / crashes:** Rust core shows a native error dialog and
  logs stderr; app does not present a blank webview.
- **Port line never arrives:** time-bounded wait in Rust, then the error dialog.
- **Analysis errors:** returned as JSON in the existing `{ error }` shape and
  rendered inline, unchanged from today.
- **Provider throws:** already caught per-provider in the kernel; unchanged.

## Testing

- Existing 71 tests: unchanged (lib logic is not modified).
- New: a sidecar smoke test — start the server, `POST /scan` a fixture directory,
  assert a non-empty graph and a known node; `POST /analyze` a small file map.
- Tauri shell logic is thin; verified by CI producing a launchable bundle and a
  manual smoke run per OS.

## Phasing (each independently verifiable)

- **Phase 1 — Decouple (local-runnable):** extract handlers, build the Bun
  sidecar, point the client at it, remove Next routes, `output: "export"`. Add
  `ci.yml`. _Verifiable as a web app + sidecar on Windows; CI green._
- **Phase 2 — Wrap:** `src-tauri/` shell, native dialog, sidecar spawn + port
  wiring, bundle `.node`. CI `release.yml` produces an unsigned Windows bundle.
  _Verifiable by downloading and launching the CI artifact._
- **Phase 3 — Cross-platform matrix:** extend `release.yml` to macOS + Linux;
  per-OS native binaries. _Verifiable by three downloadable unsigned bundles._
- **Phase 4 — Sign + auto-update:** Windows Authenticode, Apple Developer ID +
  notarization, Linux AppImage; Tauri updater plugin + manifest. _Requires
  certificates supplied by the maintainer via repo secrets._

## Open dependencies / things the maintainer must provide

- **Code-signing certificates (Phase 4):** a Windows Authenticode cert and an
  Apple Developer ID for notarization, stored as GitHub Actions secrets. Linux
  ships unsigned (AppImage/.deb). I will wire the config and document the
  secrets; I cannot obtain the certs.

## Accepted trade-offs

- **Bundle size ~100–160 MB** (Bun runtime + 26 compiled grammars). Unavoidable
  while keeping ts-morph. The grammar bulk is present in any approach.
- Pure web deployment is no longer a goal; the app is explicitly local/desktop,
  which is what lets dev and prod share the single sidecar path.
