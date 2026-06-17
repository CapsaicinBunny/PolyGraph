import { expect, test } from "bun:test";
import { isSourcePath } from "./file-filters";

test("ordinary source files are included", () => {
  expect(isSourcePath("src/foo.ts")).toBe(true);
  expect(isSourcePath("lib/bar/baz.rs")).toBe(true);
});

test("Cargo target and other build/dep dirs are excluded", () => {
  expect(isSourcePath("target/debug/.fingerprint/lib-x/lib-toml.json")).toBe(false);
  expect(isSourcePath("crate/target/release/build-script-build.json")).toBe(false);
  expect(isSourcePath(".venv/lib/site.py")).toBe(false);
  expect(isSourcePath("app/__pycache__/x.py")).toBe(false);
  expect(isSourcePath("server/bin/Debug/x.cs")).toBe(false);
  expect(isSourcePath("server/obj/x.cs")).toBe(false);
  expect(isSourcePath("vendor/foo/bar.go")).toBe(false);
});

test("non-source extensions are excluded", () => {
  expect(isSourcePath("README.md")).toBe(false);
});
