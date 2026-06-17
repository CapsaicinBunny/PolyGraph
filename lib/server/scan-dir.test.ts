import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES } from "../file-filters";
import { scanDirectory } from "./scan-dir";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polygraph-scandir-"));

  // Source files at the root and in a nested directory.
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "b.js"), "export const b = 2;\n");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "nested", "c.tsx"), "export const c = 3;\n");

  // A non-source file is skipped by extension.
  await writeFile(join(dir, "readme.md"), "# hi\n");

  // An oversize source file is skipped by the size cap.
  await writeFile(join(dir, "big.ts"), "x".repeat(MAX_FILE_BYTES + 1));

  // An ignored directory is pruned and never read.
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

  // Many files to exercise the bounded worker pool (more than the concurrency).
  await mkdir(join(dir, "many"), { recursive: true });
  for (let i = 0; i < 50; i++) {
    await writeFile(join(dir, "many", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("scanDirectory reads nested source files with forward-slash relative keys", async () => {
  const { files } = await scanDirectory(dir);
  expect(files["a.ts"]).toBe("export const a = 1;\n");
  expect(files["b.js"]).toBe("export const b = 2;\n");
  expect(files["nested/c.tsx"]).toBe("export const c = 3;\n");
});

test("scanDirectory reads every file in a directory larger than the worker pool", async () => {
  const { files } = await scanDirectory(dir);
  for (let i = 0; i < 50; i++) {
    expect(files[`many/f${i}.ts`]).toBe(`export const f${i} = ${i};\n`);
  }
});

test("scanDirectory skips non-source and oversize files but counts them", async () => {
  const { files, skipped } = await scanDirectory(dir);
  // readme.md (extension) + big.ts (size) are skipped.
  expect(skipped).toBe(2);
  expect(files["readme.md"]).toBeUndefined();
  expect(files["big.ts"]).toBeUndefined();
});

test("scanDirectory prunes ignored directories without reading or counting them", async () => {
  const { files } = await scanDirectory(dir);
  expect(files["node_modules/pkg/index.js"]).toBeUndefined();
});

test("scanDirectory returns exactly the expected source files", async () => {
  const { files } = await scanDirectory(dir);
  const keys = Object.keys(files).sort();
  const expected = [
    "a.ts",
    "b.js",
    "nested/c.tsx",
    ...Array.from({ length: 50 }, (_, i) => `many/f${i}.ts`),
  ].sort();
  expect(keys).toEqual(expected);
});
