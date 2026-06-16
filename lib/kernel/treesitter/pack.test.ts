import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { packsDir } from "./pack";

const original = process.env.POLYGRAPH_PACKS;

afterEach(() => {
  if (original === undefined) delete process.env.POLYGRAPH_PACKS;
  else process.env.POLYGRAPH_PACKS = original;
});

test("uses POLYGRAPH_PACKS when set", () => {
  process.env.POLYGRAPH_PACKS = "/opt/app/resources/language-packs";
  expect(packsDir()).toBe("/opt/app/resources/language-packs");
});

test("falls back to the repo-relative default", () => {
  delete process.env.POLYGRAPH_PACKS;
  expect(packsDir()).toBe(join(process.cwd(), "language-packs"));
});

test("treats an empty POLYGRAPH_PACKS as unset", () => {
  process.env.POLYGRAPH_PACKS = "";
  expect(packsDir()).toBe(join(process.cwd(), "language-packs"));
});
