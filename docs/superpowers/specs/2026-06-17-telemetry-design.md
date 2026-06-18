# Analytics & logging (telemetry) — design

Deep, structured instrumentation of PolyGraph, with a Settings disable toggle.
Focus: **LOD (adaptive cut)** and **rendering**, plus the **analysis engine**.
Surfaced as **structured console logs** + a **downloadable session log** (no live
HUD). Default **on**; disabling makes every hook a zero-cost no-op.

## Telemetry core — `lib/telemetry/` (pure, unit-tested)

- **`events.ts`** — `TelemetryLog`, a bounded ring buffer (default 5000). Event:
  `{ t: number; category: Category; level: Level; event: string; data?: object }`.
  `Category = "analysis" | "layout" | "scene" | "lod" | "render"`,
  `Level = "debug" | "info" | "warn" | "error"`. API: `push`, `snapshot`,
  `toNDJSON`, `clear`.
- **`metrics.ts`** — named rolling series (`Histogram`): `record(v)`, `count`,
  `mean`, `p50/p95/p99`, `min/max`, `reset`. A `Metrics` registry of named
  histograms + counters.
- **`telemetry.ts`** — the `Telemetry` singleton bus:
  - `enabled` persisted to `localStorage["polygraph.telemetry"]` (default `true`);
    `setEnabled(b)`. When disabled, `log`/`time`/`metric` return immediately.
  - `log(category, event, data?, level?)` → push to the ring buffer and, when
    enabled, mirror to `console` as `[category] event {…}`.
  - `time(category, event, fn)` → run `fn`, record duration into `metric` and an
    event. `now()` indirection so tests are deterministic.
  - `metric(series, value)` → record into a histogram.
  - `snapshot()` / `downloadLog()` for the export.

## Hooks

### LOD (deepest)
`lib/graph/lod-cut.ts` gains `computeCutTraced(...)` returning `{ cut, trace }`
where `trace` is the per-directory decision list:
`{ path, depth, onScreen, screenHeightPx, thresholdPx, decision, reason }`
(`decision = "open" | "collapse"`, `reason = "off-screen" | "too-small" |
"budget" | "opened"`). `computeCut` stays the zero-overhead hot path; the traced
variant runs only when telemetry is enabled.

`VelloGraphCanvas` LOD recompute logs, per cut:
`{ trigger, cam:{x,y,scale}, band, prevBand, viewport, dirsEvaluated,
dirsOnScreen, openPx, maxCards, cutSize, prevCutSize, cardsRendered, computeMs,
changed, opened:[…], collapsed:[…] }` (opened/collapsed = the diff vs the prior
cut), plus the full `trace`, plus `metric("lod.computeMs")`,
`metric("lod.cutSize")`, `metric("lod.cards")`.

### Render — JS + Rust
- JS: per-frame ms + FPS (animate loop), `set_data` payload **bytes** + node/edge
  counts, fit/pan/zoom events.
- Rust (`vello-renderer`): a `RenderStats` accumulated in `render()` — nodes
  total/drawn/culled, edges total/encoded (after the stride cap), clusters drawn,
  encode ms — exposed via a `stats() -> String` (JSON) method. JS reads it after
  each `render()` and logs `("render","frame", {fps, frameMs, payloadBytes,
  …stats})`. **One wasm rebuild.**

### Analysis
The sidecar already times `scanMs`/`analyzeMs`; surface them in the scan response
meta (additive `timings`), and the client logs on result:
`{ fileCount, nodes, edges, scanMs, analyzeMs, batches?, parseErrors, trimmed,
manifests }`.

### Layout
`useScene` routes its existing timing through telemetry:
`("layout","run", { algorithm, nodes, ms, cacheHit })`.

## Surfacing & control

- **Settings panel** gains: an **"Analytics & logging: on/off"** toggle (wired to
  `telemetry.setEnabled`, default on) and a **"Download session log"** button
  (NDJSON via `lib/client/download`).
- Console mirror is gated by the toggle.

## Verification

- Telemetry core (`events`, `metrics`, `telemetry`) + `computeCutTraced`: full
  unit tests (deterministic via injected `now`).
- Rust stats: `cargo check` (wasm32) + rebuild; existing render path untouched
  except the stat counters.
- Hooks: `typecheck` + full suite. Console/download paths: manual.

## Non-goals

- No live in-app HUD/overlay (chosen: console + downloadable log).
- No server-side log persistence; the session log is client-side, on demand.
