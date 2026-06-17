import { describe, expect, test } from "bun:test";
import { matchAnyGlob, matchGlob } from "./match";

describe("matchGlob", () => {
  test("** crosses directory boundaries", () => {
    expect(matchGlob("src/domain/**", "src/domain/order.ts")).toBe(true);
    expect(matchGlob("src/domain/**", "src/domain/sub/deep/order.ts")).toBe(true);
    expect(matchGlob("src/domain/**", "src/ui/widget.ts")).toBe(false);
  });

  test("* stays within a segment", () => {
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/sub/index.ts")).toBe(false);
  });

  test("leading **/ matches at any depth, including root", () => {
    expect(matchGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchGlob("**/*.test.ts", "lib/graph/query.test.ts")).toBe(true);
    expect(matchGlob("**/*.test.ts", "lib/graph/query.ts")).toBe(false);
  });

  test("interior /**/ matches zero or more segments", () => {
    expect(matchGlob("a/**/b", "a/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/x/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/x/y/b")).toBe(true);
    expect(matchGlob("a/**/b", "a/b/c")).toBe(false);
  });

  test("? matches exactly one non-slash char", () => {
    expect(matchGlob("file?.ts", "file1.ts")).toBe(true);
    expect(matchGlob("file?.ts", "file.ts")).toBe(false);
    expect(matchGlob("a/?/b", "a//b")).toBe(false);
  });

  test("regex specials in the literal are escaped", () => {
    expect(matchGlob("a.b/c+d.ts", "a.b/c+d.ts")).toBe(true);
    expect(matchGlob("a.b/c+d.ts", "axb/c+d.ts")).toBe(false);
  });

  test("backslash paths are normalized before matching", () => {
    expect(matchGlob("src/domain/**", "src\\domain\\order.ts")).toBe(true);
  });

  test("bare ** matches everything", () => {
    expect(matchGlob("**", "anything/at/all.ts")).toBe(true);
  });

  test("matchAnyGlob ORs the patterns; empty matches nothing", () => {
    expect(matchAnyGlob(["src/a/**", "src/b/**"], "src/b/x.ts")).toBe(true);
    expect(matchAnyGlob(["src/a/**", "src/b/**"], "src/c/x.ts")).toBe(false);
    expect(matchAnyGlob([], "src/c/x.ts")).toBe(false);
  });
});
