// Benchmark runner. Measures, per fixture: scan time, incremental scan time, layout
// time (smart + layered), memory, and node/edge counts. Prints a table, writes
// bench/results/latest.json, and (with --check) gates against committed baselines.
//
//   bun run bench            # measure + print + write results
//   bun run bench:check      # measure + fail if a metric regressed past its threshold
//   bun run bench:update     # measure + rewrite baselines.json
//
// Renderer frame time + WASM memory are intentionally out of scope (WebGPU is
// browser-only; Playwright doesn't run under Bun) — see docs/BENCHMARKS.md.

import { analyze, layoutGraph } from "./harness";
import { availableFixtures, loadFixture } from "./fixtures";
import { measureMemory, round, timeIt } from "./metrics";
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
};

interface Row {
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

/** Return a copy of `files` with one file's contents perturbed (forces a re-scan). */
function touchOneFile(files: SourceFileMap): SourceFileMap {
  const next = { ...files };
  const first = Object.keys(next)[0];
  if (first) next[first] = `${next[first]}\n// bench-incremental-touch\n`;
  return next;
}

async function benchFixture(fx: Awaited<ReturnType<typeof loadFixture>>): Promise<Row> {
  // Iterate fewer times on big inputs to keep the run reasonable.
  const iters = fx.fileCount > 500 ? 3 : 6;

  const result = await analyze(fx);
  const graph = result.graph;

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

function metricsOf(r: Row): Record<string, number> {
  return {
    scanMs: r.scanMs,
    incrementalMs: r.incrementalMs,
    smartLayoutMs: r.smartLayoutMs,
    layeredLayoutMs: r.layeredLayoutMs,
    rssMb: r.rssMb,
  };
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--update")
    ? "update"
    : process.argv.includes("--check")
      ? "check"
      : "report";

  const fixtures = availableFixtures();
  const rows: Row[] = [];
  for (const fx of fixtures) {
    process.stderr.write(`  benchmarking ${fx.id}…\n`);
    rows.push(await benchFixture(await loadFixture(fx)));
  }

  console.table(
    rows.map((r) => ({
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

  await Bun.write(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`);

  if (mode === "update") {
    const baselines: Record<string, Record<string, number>> = {};
    for (const r of rows) baselines[r.id] = metricsOf(r);
    await Bun.write(BASELINES, `${JSON.stringify(baselines, null, 2)}\n`);
    console.error(`\nWrote baselines for ${rows.length} fixtures → ${BASELINES}`);
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
    for (const r of rows) {
      const base = baselines[r.id];
      if (!base) {
        console.error(`⚠ no baseline for fixture "${r.id}" (skipping)`);
        continue;
      }
      for (const [metric, value] of Object.entries(metricsOf(r))) {
        const baseVal = base[metric];
        if (baseVal === undefined) continue;
        const limit = baseVal * (1 + (THRESHOLDS[metric] ?? 0.25));
        // Ignore sub-millisecond / sub-MB noise on tiny fixtures.
        if (value > limit && value - baseVal > 1) {
          failed++;
          console.error(
            `✗ ${r.id}.${metric}: ${value} > ${round(limit)} (baseline ${baseVal}, +${round(((value - baseVal) / baseVal) * 100)}%)`,
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
