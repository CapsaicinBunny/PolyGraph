import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheKeys, clearScanCache, getScan } from "./cache";

// Six trivial single-file projects, so the LRU (cap 4) can be exercised.
const dirs: string[] = [];

beforeAll(async () => {
  for (let i = 0; i < 6; i++) {
    const d = await mkdtemp(join(tmpdir(), `polygraph-lru-${i}-`));
    await writeFile(join(d, "x.ts"), `export const v${i} = ${i};\n`);
    dirs.push(d);
  }
});

afterAll(async () => {
  clearScanCache();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("getScan evicts the least-recently-used project past the cap of 4, and a hit promotes", async () => {
  clearScanCache();
  for (let i = 0; i < 4; i++) await getScan(dirs[i]!);
  expect(cacheKeys().length).toBe(4);

  // Touch dir0 (a cache hit) so it becomes most-recently-used; dir1 is now the LRU.
  await getScan(dirs[0]!);

  // A 5th distinct root evicts the LRU (dir1) — size stays at 4, dir0 survives.
  await getScan(dirs[4]!);
  const keys = cacheKeys();
  expect(keys.length).toBe(4);
  expect(keys).toContain(resolve(dirs[0]!));
  expect(keys).toContain(resolve(dirs[4]!));
  expect(keys).not.toContain(resolve(dirs[1]!));
});
