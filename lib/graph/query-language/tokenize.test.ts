import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokenize";

const types = (src: string) => tokenize(src).map((t) => t.type);
const pairs = (src: string) => tokenize(src).map((t) => `${t.type}:${t.value}`);

describe("tokenize", () => {
  test("empty / whitespace only", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \t ")).toEqual([]);
  });

  test("a bare word", () => {
    expect(pairs("hello")).toEqual(["word:hello"]);
  });

  test("field:value stays one word token", () => {
    expect(pairs("kind:function")).toEqual(["word:kind:function"]);
  });

  test("numeric comparison stays one word token", () => {
    expect(pairs("calls:>10")).toEqual(["word:calls:>10"]);
  });

  test("mid-word hyphen is kept, not treated as negation", () => {
    expect(pairs("depends-on:database")).toEqual(["word:depends-on:database"]);
    expect(pairs("role:react-component")).toEqual(["word:role:react-component"]);
  });

  test("leading hyphen is a negation token", () => {
    expect(types("-kind:function")).toEqual(["not", "word"]);
    expect(pairs("-kind:function")).toEqual(["not:-", "word:kind:function"]);
  });

  test("path arrow with and without surrounding spaces", () => {
    expect(types("environment:client -> environment:server")).toEqual(["word", "arrow", "word"]);
    expect(types("client->server")).toEqual(["word", "arrow", "word"]);
  });

  test("quoted value is its own token, quotes stripped", () => {
    expect(pairs('depends-on:"a database"')).toEqual(["word:depends-on:", "quoted:a database"]);
  });

  test("parentheses and pipe are structural", () => {
    expect(types("(a | b)")).toEqual(["lparen", "word", "pipe", "word", "rparen"]);
  });

  test("unterminated quote runs to end of input", () => {
    expect(pairs('"abc')).toEqual(["quoted:abc"]);
  });
});
