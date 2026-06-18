// Golden-graph correctness snapshots for the stable committed sample fixtures.
// A structural summary (counts by kind, cycles, top hubs, content hash) is compared
// to a committed snapshot — drift in the analyzer's output fails here. Regenerate
// with `bun test --update-snapshots`. Runs as part of the normal `bun test`.

import { describe, expect, test } from "bun:test";
import { loadFixture, stableFixtures } from "./fixtures";
import { analyze, summarize } from "./harness";

describe("golden graphs", () => {
  for (const fx of stableFixtures()) {
    test(`${fx.id} structural snapshot`, async () => {
      const { graph } = await analyze(await loadFixture(fx));
      expect(summarize(graph)).toMatchSnapshot();
    });
  }
});
