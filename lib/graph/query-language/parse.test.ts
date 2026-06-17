import { describe, expect, test } from "bun:test";
import { type Node, parse } from "./parse";

const ast = (src: string): Node | null => parse(src).ast;

describe("parse", () => {
  test("empty query is null", () => {
    expect(parse("").ast).toBeNull();
  });

  test("bare word -> text node", () => {
    expect(ast("hello")).toEqual({ type: "text", value: "hello" });
  });

  test("field:value -> predicate with = op", () => {
    expect(ast("kind:function")).toEqual({
      type: "predicate",
      field: "kind",
      op: "=",
      value: "function",
    });
  });

  test("numeric comparison op is split out", () => {
    expect(ast("calls:>10")).toEqual({
      type: "predicate",
      field: "calls",
      op: ">",
      value: "10",
    });
    expect(ast("incoming:>=5")).toEqual({
      type: "predicate",
      field: "incoming",
      op: ">=",
      value: "5",
    });
  });

  test("quoted value attaches to field", () => {
    expect(ast('depends-on:"a database"')).toEqual({
      type: "predicate",
      field: "depends-on",
      op: "=",
      value: "a database",
    });
  });

  test("implicit AND by juxtaposition", () => {
    expect(ast("path:src/api/** incoming:>5")).toEqual({
      type: "and",
      items: [
        { type: "predicate", field: "path", op: "=", value: "src/api/**" },
        { type: "predicate", field: "incoming", op: ">", value: "5" },
      ],
    });
  });

  test("negation with leading hyphen and with `not`", () => {
    const expected: Node = {
      type: "not",
      expr: { type: "predicate", field: "kind", op: "=", value: "function" },
    };
    expect(ast("-kind:function")).toEqual(expected);
    expect(ast("not kind:function")).toEqual(expected);
  });

  test("OR via pipe and via keyword", () => {
    const expected: Node = {
      type: "or",
      items: [
        { type: "text", value: "a" },
        { type: "text", value: "b" },
      ],
    };
    expect(ast("a | b")).toEqual(expected);
    expect(ast("a or b")).toEqual(expected);
  });

  test("parentheses group an OR inside an AND", () => {
    expect(ast("kind:function (a | b)")).toEqual({
      type: "and",
      items: [
        { type: "predicate", field: "kind", op: "=", value: "function" },
        {
          type: "or",
          items: [
            { type: "text", value: "a" },
            { type: "text", value: "b" },
          ],
        },
      ],
    });
  });

  test("path arrow builds a path node", () => {
    expect(ast("environment:client -> environment:server")).toEqual({
      type: "path",
      from: { type: "predicate", field: "environment", op: "=", value: "client" },
      to: { type: "predicate", field: "environment", op: "=", value: "server" },
    });
  });

  test("unbalanced paren reports an error", () => {
    expect(parse("(a | b").error).toBeTruthy();
  });
});
