import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("splits command, positional path, and flags", () => {
    const { positionals, flags } = parseArgs(["check", ".", "--format", "sarif"]);
    expect(positionals).toEqual(["check", "."]);
    expect(flags.format).toBe("sarif");
  });

  test("supports --flag=value", () => {
    expect(parseArgs(["check", "--baseline=main"]).flags.baseline).toBe("main");
  });

  test("a flag with no value is boolean true", () => {
    expect(parseArgs(["diff", "--json"]).flags.json).toBe("true");
  });

  test("does not consume a following flag as a value", () => {
    const { flags } = parseArgs(["check", "--baseline", "--format", "sarif"]);
    expect(flags.baseline).toBe("true");
    expect(flags.format).toBe("sarif");
  });
});
