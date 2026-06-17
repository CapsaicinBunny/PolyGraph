// Layout-stability snapshots: node positions for the sample fixture under smart +
// layered layout, compared to a committed snapshot within a px tolerance (layout is
// deterministic — no Math.random — so real layout changes fail this, while tiny
// cross-platform float drift doesn't). Regenerate with BENCH_UPDATE=1 bun test.

import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
import { loadFixture, LOCAL_FIXTURES } from "./fixtures";
import { analyze, layoutGraph } from "./harness";
import { round } from "./metrics";
import type { LayoutAlgorithm } from "../lib/layout";

const TOLERANCE_PX = 2;
const UPDATE = process.env.BENCH_UPDATE === "1";
const fixture = LOCAL_FIXTURES.find((f) => f.id === "sample-ts");

for (const algo of ["smart", "layered"] as LayoutAlgorithm[]) {
  test(`layout stability: sample-ts / ${algo}`, async () => {
    if (!fixture) throw new Error("sample-ts fixture missing");
    const { graph } = await analyze(await loadFixture(fixture));
    const positions = await layoutGraph(graph, algo);

    const snap: Record<string, [number, number]> = {};
    for (const [id, p] of positions) snap[id] = [round(p.x, 1), round(p.y, 1)];

    const file = `${import.meta.dir}/stability/sample-ts-${algo}.json`;
    if (UPDATE || !existsSync(file)) {
      await Bun.write(file, `${JSON.stringify(snap, null, 2)}\n`);
      return;
    }

    const golden = (await Bun.file(file).json()) as Record<string, [number, number]>;
    expect(Object.keys(snap).sort()).toEqual(Object.keys(golden).sort());
    for (const id of Object.keys(golden)) {
      const [gx, gy] = golden[id];
      const [x, y] = snap[id];
      expect(Math.abs(x - gx)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(y - gy)).toBeLessThanOrEqual(TOLERANCE_PX);
    }
  });
}
