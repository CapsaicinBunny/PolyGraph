# Benchmarks & golden-graph suite

A `bench/` suite that tracks performance and guards correctness/stability as the
feature surface grows. Everything runs under Bun — no browser required.

## Commands

```bash
bun run bench           # measure all fixtures, print a table, write bench/results/latest.json
bun run bench:check     # measure + fail if a metric regressed past its threshold (vs baselines)
bun run bench:update    # measure + rewrite bench/baselines.json
bun run bench:fetch     # clone the optional pinned real-world repos (see Fixtures)
bun test bench/         # run the golden-graph + layout-stability snapshot tests
```

The golden + stability snapshots also run as part of the normal `bun test`, so CI
gates them on every PR.

## What's tracked

| Metric                         | Where                     | Notes                                                                                                            |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Scan time (by language & size) | `bench/run.ts`            | `analyzeProject` per fixture, median of N runs                                                                   |
| Incremental scan time          | `bench/run.ts`            | re-scan after touching one file — currently ≈ full scan (no per-file caching yet; tracked so the gap is visible) |
| Layout time                    | `bench/run.ts`            | `smart` + `layered`, file-level view                                                                             |
| Memory                         | `bench/run.ts`            | RSS / heap growth around a scan (run with `--expose-gc` for tighter numbers)                                     |
| Node / edge counts             | `bench/run.ts`            | per fixture, plus a size signal                                                                                  |
| Correctness (golden graphs)    | `bench/golden.test.ts`    | structural snapshot — counts by kind, cycles, top hubs, content hash                                             |
| Layout stability               | `bench/stability.test.ts` | node positions per algorithm, compared within a ±2px tolerance                                                   |

**Deferred (out of scope here):** renderer frame time and WASM/GPU memory. The
renderer is WebGPU (browser-only) and Playwright doesn't run under Bun, so those
need a separate headless-WebGPU harness — a future phase.

## Scale suite (LOD)

`bench/run.ts` also benchmarks the 100k-scale path on **synthetic** graphs
(`bench/synthetic.ts`, deterministic, no scanning) at sizes the real fixtures don't
reach:

| Metric           | Source                                          | Notes                                                                                                           |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Layout (guarded) | `layoutGraph`                                   | above 6000 nodes the layout-client size guard drops to `grid`, so this is the real layout the app runs at scale |
| Hierarchy build  | `lib/graph/hierarchy.ts` `buildDirTree`         | directory tree from the graph                                                                                   |
| Adaptive cut     | `lib/graph/lod-cut.ts` `computeCut`             | the camera-driven LOD cut (the render-engine core)                                                              |
| Auto-collapse    | `lib/graph/auto-collapse.ts` `autoCollapseDirs` | huge-graph aggregation                                                                                          |

Sizes are `SCALE_SIZES` in `run.ts` (default 1000, 8000, 100000 — 8000 crosses the
layout guard + analyzer batch threshold; 100000 is the headline scale target). These
feed the same baselines / `bench:check` gating as the fixture metrics.

## Fixtures (`bench/fixtures.ts`)

- **Committed samples** — `bench/fixtures/sample{,-py,-go}` — tiny, content-stable
  projects used for the golden + stability snapshots (so they don't drift).
- **`self`** — the PolyGraph repo itself, a real-world TS+Rust sample (perf only;
  not snapshotted, since it changes every commit).
- **Remote (optional)** — pinned real-world repos in `REMOTE_FIXTURES`, fetched into
  `bench/.fixtures/<id>` (gitignored) by `bun run bench:fetch`. Pinned to a commit
  SHA for reproducibility; add repos there to broaden per-language / size coverage.

## Baselines & gating

`bench/baselines.json` holds reference medians. `bun run bench:check` fails when a
metric exceeds `baseline * (1 + threshold)` (time +25%, layout +30%, memory +40%),
ignoring sub-ms/sub-MB noise.

Absolute timings are **machine-dependent**, so baselines are only meaningful on the
machine that produced them. CI runs `bun run bench` in **report** mode (numbers in the
logs, no gating). To gate perf in CI, regenerate baselines on the CI runner
(`bench:update`) and switch the CI step to `bench:check`.

## Updating snapshots

- Golden graphs: `bun test bench/golden.test.ts --update-snapshots`
- Layout stability: `BENCH_UPDATE=1 bun test bench/stability.test.ts`
- Perf baselines: `bun run bench:update`

Review the diff before committing — a changed golden/stability snapshot means the
analyzer's output or a layout changed.
