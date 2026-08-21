// Benchmark runner. Two suites:
//   1. Fixtures   — per project: scan, incremental scan, layout (smart+layered), memory, counts.
//   2. Scale      — synthetic large graphs: layout + the LOD pipeline (hierarchy build,
//                   adaptive cut, auto-collapse) at sizes the real fixtures don't reach.
// Prints tables, writes bench/results/latest.json, and (with --check) gates every metric
// against committed baselines.
//
//   bun run bench            # measure + print + write results
//   bun run bench:check      # measure + fail if a metric regressed past its threshold
//   bun run bench:update     # measure + rewrite baselines.json
//
// Renderer frame time + WASM memory are intentionally out of scope (WebGPU is
// browser-only; Playwright doesn't run under Bun) — see docs/BENCHMARKS.md.

import { analyze, layoutGraph } from "./harness";
import { availableFixtures, loadFixture } from "./fixtures";
import { makeSyntheticGraph } from "./synthetic";
import { measureMemory, round, timeIt } from "./metrics";
import { buildDirTree } from "../lib/graph/hierarchy";
import { autoCollapseDirs } from "../lib/graph/auto-collapse";
import type { SourceFileMap } from "../lib/graph/types";

const BASELINES = `${import.meta.dir}/baselines.json`;
const RESULTS = `${import.meta.dir}/results/latest.json`;

// A metric regresses if it grows past baseline * (1 + threshold).
const THRESHOLDS: Record<string, number> = {
  scanMs: 0.25,
  incrementalMs: 0.25,
  smartLayoutMs: 0.3,
  layeredLayoutMs: 0.3,
  rssMb: 0.4,
  layoutMs: 0.3,
  hierarchyMs: 0.3,
  autoCollapseMs: 0.3,
};
const DEFAULT_THRESHOLD = 0.3;

// Synthetic graph sizes for the scale suite. 8000 crosses the layout size-guard
// (>6000 nodes → grid) and the analyzer batch threshold; 100000 is the headline
// "scale to 100k+" target, exercising the LOD pipeline at full size.
const SCALE_SIZES = [1000, 8000, 100_000];

interface FixtureRow {
  id: string;
  language: string;
  files: number;
  nodes: number;
  edges: number;
  scanMs: number;
  incrementalMs: number;
  smartLayoutMs: number;
  layeredLayoutMs: number;
  rssMb: number;
}

interface ScaleRow {
  id: string;
  nodes: number;
  edges: number;
  layoutMs: number;
  hierarchyMs: number;
  autoCollapseMs: number;
}

/** Return a copy of `files` with one file's contents perturbed (forces a re-scan). */
function touchOneFile(files: SourceFileMap): SourceFileMap {
  const next = { ...files };
  const first = Object.keys(next)[0];
  if (first) next[first] = `${next[first]}\n// bench-incremental-touch\n`;
  return next;
}

async function benchFixture(fx: Awaited<ReturnType<typeof loadFixture>>): Promise<FixtureRow> {
  const iters = fx.fileCount > 500 ? 3 : 6;
  const graph = (await analyze(fx)).graph;

  const scan = await timeIt(() => analyze(fx), iters);
  const touched = { ...fx, files: touchOneFile(fx.files) };
  const incremental = await timeIt(() => analyze(touched), iters);
  const smart = await timeIt(() => layoutGraph(graph, "smart"), iters);
  const layered = await timeIt(() => layoutGraph(graph, "layered"), iters);
  const mem = await measureMemory(() => analyze(fx));

  return {
    id: fx.id,
    language: fx.language,
    files: fx.fileCount,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    scanMs: scan.median,
    incrementalMs: incremental.median,
    smartLayoutMs: smart.median,
    layeredLayoutMs: layered.median,
    rssMb: mem.rssMb,
  };
}

async function benchScale(size: number): Promise<ScaleRow> {
  const graph = makeSyntheticGraph(size);
  const iters = size > 50_000 ? 2 : size > 4000 ? 3 : 6;

  // Layout note: the layout-client size guard forces `grid` above 6000 nodes, so
  // this measures the real (guarded) layout the app would run at this size.
  const layout = await timeIt(() => layoutGraph(graph, "smart"), iters);
  const hierarchy = await timeIt(() => buildDirTree(graph), iters);

  // The geometry-free initial-collapse seed (the Directory LOD bootstrap). The C1a camera
  // cut (`computeCut`) has been retired — the representation cut is the sole LOD authority
  // and is benched in bench/lod-parity.ts; this scale suite keeps the seed/hierarchy timings.
  const auto = await timeIt(() => autoCollapseDirs(graph, 2000), iters);

  return {
    id: `scale-${size}`,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    layoutMs: layout.median,
    hierarchyMs: hierarchy.median,
    autoCollapseMs: auto.median,
  };
}

function fixtureMetrics(r: FixtureRow): Record<string, number> {
  return {
    scanMs: r.scanMs,
    incrementalMs: r.incrementalMs,
    smartLayoutMs: r.smartLayoutMs,
    layeredLayoutMs: r.layeredLayoutMs,
    rssMb: r.rssMb,
  };
}
function scaleMetrics(r: ScaleRow): Record<string, number> {
  return {
    layoutMs: r.layoutMs,
    hierarchyMs: r.hierarchyMs,
    autoCollapseMs: r.autoCollapseMs,
  };
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--update")
    ? "update"
    : process.argv.includes("--check")
      ? "check"
      : "report";

  const fixtureRows: FixtureRow[] = [];
  for (const fx of availableFixtures()) {
    process.stderr.write(`  fixture ${fx.id}…\n`);
    fixtureRows.push(await benchFixture(await loadFixture(fx)));
  }
  const scaleRows: ScaleRow[] = [];
  for (const size of SCALE_SIZES) {
    process.stderr.write(`  scale ${size}…\n`);
    scaleRows.push(await benchScale(size));
  }

  console.table(
    fixtureRows.map((r) => ({
      fixture: r.id,
      lang: r.language,
      files: r.files,
      nodes: r.nodes,
      edges: r.edges,
      scan: `${r.scanMs}ms`,
      incr: `${r.incrementalMs}ms`,
      smart: `${r.smartLayoutMs}ms`,
      layered: `${r.layeredLayoutMs}ms`,
      rss: `${r.rssMb}MB`,
    })),
  );
  console.table(
    scaleRows.map((r) => ({
      scale: r.id,
      nodes: r.nodes,
      edges: r.edges,
      "layout(guarded)": `${r.layoutMs}ms`,
      hierarchy: `${r.hierarchyMs}ms`,
      "auto-collapse": `${r.autoCollapseMs}ms`,
    })),
  );

  const metricsById: Record<string, Record<string, number>> = {};
  for (const r of fixtureRows) metricsById[r.id] = fixtureMetrics(r);
  for (const r of scaleRows) metricsById[r.id] = scaleMetrics(r);

  await Bun.write(
    RESULTS,
    `${JSON.stringify({ at: new Date().toISOString(), fixtures: fixtureRows, scale: scaleRows }, null, 2)}\n`,
  );

  if (mode === "update") {
    await Bun.write(BASELINES, `${JSON.stringify(metricsById, null, 2)}\n`);
    console.error(
      `\nWrote baselines for ${Object.keys(metricsById).length} entries → ${BASELINES}`,
    );
    return;
  }

  if (mode === "check") {
    const baselines = (await Bun.file(BASELINES)
      .json()
      .catch(() => null)) as Record<string, Record<string, number>> | null;
    if (!baselines) {
      console.error("No baselines.json — run `bun run bench:update` first.");
      process.exit(1);
    }
    let failed = 0;
    for (const [id, metrics] of Object.entries(metricsById)) {
      const base = baselines[id];
      if (!base) {
        console.error(`⚠ no baseline for "${id}" (skipping)`);
        continue;
      }
      for (const [metric, value] of Object.entries(metrics)) {
        const baseVal = base[metric];
        if (baseVal === undefined) continue;
        const limit = baseVal * (1 + (THRESHOLDS[metric] ?? DEFAULT_THRESHOLD));
        // Ignore sub-millisecond / sub-MB noise on tiny inputs.
        if (value > limit && value - baseVal > 1) {
          failed++;
          console.error(
            `✗ ${id}.${metric}: ${value} > ${round(limit)} (baseline ${baseVal}, +${round(((value - baseVal) / baseVal) * 100)}%)`,
          );
        }
      }
    }
    if (failed > 0) {
      console.error(`\n${failed} metric(s) regressed beyond threshold.`);
      process.exit(1);
    }
    console.error("\n✓ all metrics within threshold of baseline.");
  }
}

await main();
