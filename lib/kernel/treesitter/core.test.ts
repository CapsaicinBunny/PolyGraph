import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCorePath } from "./core";

const original = process.env.POLYGRAPH_CORE;

afterEach(() => {
  if (original === undefined) delete process.env.POLYGRAPH_CORE;
  else process.env.POLYGRAPH_CORE = original;
});

test("uses POLYGRAPH_CORE when set", () => {
  process.env.POLYGRAPH_CORE = "/opt/app/analyzer-core.node";
  expect(resolveCorePath()).toBe("/opt/app/analyzer-core.node");
});

test("falls back to the repo-relative default", () => {
  delete process.env.POLYGRAPH_CORE;
  expect(resolveCorePath()).toBe(
    join(process.cwd(), "analyzer-core", "analyzer-core.node"),
  );
});
