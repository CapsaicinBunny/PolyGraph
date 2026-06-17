import { describe, expect, test } from "bun:test";
import { parseToml } from "./toml";

describe("parseToml", () => {
  test("top-level keys and a table", () => {
    const t = parseToml(`
      name = "demo"
      version = "1.2.3"

      [package]
      name = "core"
      edition = 2021
    `);
    expect(t.name).toBe("demo");
    expect((t.package as Record<string, unknown>).name).toBe("core");
    expect((t.package as Record<string, unknown>).edition).toBe(2021);
  });

  test("dependency table with string and inline-table values", () => {
    const t = parseToml(`
      [dependencies]
      serde = "1.0"
      tokio = { version = "1", features = ["full"] }
    `);
    const deps = t.dependencies as Record<string, unknown>;
    expect(deps.serde).toBe("1.0");
    expect((deps.tokio as Record<string, unknown>).version).toBe("1");
  });

  test("multi-line array (workspace members)", () => {
    const t = parseToml(`
      [workspace]
      members = [
        "crates/core",
        "crates/util",
      ]
    `);
    expect((t.workspace as Record<string, unknown>).members).toEqual([
      "crates/core",
      "crates/util",
    ]);
  });

  test("comments are ignored, including trailing", () => {
    const t = parseToml(`
      # a comment
      name = "x"  # trailing
    `);
    expect(t.name).toBe("x");
  });

  test("dotted keys nest", () => {
    const t = parseToml(`[tool.poetry]\nname = "pkg"`);
    const tool = t.tool as Record<string, Record<string, unknown>>;
    expect(tool.poetry.name).toBe("pkg");
  });
});
