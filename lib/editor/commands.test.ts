import { describe, expect, test } from "bun:test";
import {
  editorInvocation,
  fileLocation,
  openInvocation,
  revealInvocation,
  symbolPath,
  toAbsolute,
} from "./commands";

describe("toAbsolute", () => {
  test("joins and normalizes for windows", () => {
    expect(toAbsolute("C:\\proj", "src/a.ts", "win32")).toBe("C:\\proj\\src\\a.ts");
    expect(toAbsolute("C:\\proj\\", "src/a.ts", "win32")).toBe("C:\\proj\\src\\a.ts");
  });
  test("joins and normalizes for posix", () => {
    expect(toAbsolute("/home/u/proj", "src/a.ts", "linux")).toBe("/home/u/proj/src/a.ts");
    expect(toAbsolute("/home/u/proj/", "lib\\b.ts", "darwin")).toBe("/home/u/proj/lib/b.ts");
  });
});

describe("editorInvocation", () => {
  test("VS Code uses --goto file:line:col", () => {
    const inv = editorInvocation("vscode", "/p", "src/a.ts", 42, "linux", 7);
    expect(inv.program).toBe("code");
    expect(inv.args).toEqual(["--goto", "/p/src/a.ts:42:7"]);
  });

  test("VS Code program is code.cmd on windows", () => {
    expect(editorInvocation("vscode", "C:\\p", "a.ts", 1, "win32").program).toBe("code.cmd");
  });

  test("JetBrains uses --line N --column C path", () => {
    const inv = editorInvocation("jetbrains", "/p", "src/a.ts", 10, "darwin");
    expect(inv.program).toBe("idea");
    expect(inv.args).toEqual(["--line", "10", "--column", "1", "/p/src/a.ts"]);
  });

  test("line and column are floored to 1", () => {
    const inv = editorInvocation("vscode", "/p", "a.ts", 0, "linux", 0);
    expect(inv.args[1]).toBe("/p/a.ts:1:1");
  });
});

describe("revealInvocation", () => {
  test("windows uses explorer /select", () => {
    expect(revealInvocation("C:\\p", "src/a.ts", "win32")).toEqual({
      program: "explorer",
      args: ["/select,C:\\p\\src\\a.ts"],
    });
  });
  test("macOS uses open -R", () => {
    expect(revealInvocation("/p", "src/a.ts", "darwin")).toEqual({
      program: "open",
      args: ["-R", "/p/src/a.ts"],
    });
  });
  test("linux opens the containing directory", () => {
    expect(revealInvocation("/p", "src/a.ts", "linux")).toEqual({
      program: "xdg-open",
      args: ["/p/src"],
    });
  });
});

describe("openInvocation (OS default app)", () => {
  test("windows uses start via cmd", () => {
    expect(openInvocation("C:\\p", "src/a.ts", "win32")).toEqual({
      program: "cmd",
      args: ["/c", "start", "", "C:\\p\\src\\a.ts"],
    });
  });
  test("macOS uses open", () => {
    expect(openInvocation("/p", "src/a.ts", "darwin")).toEqual({
      program: "open",
      args: ["/p/src/a.ts"],
    });
  });
  test("linux uses xdg-open on the file", () => {
    expect(openInvocation("/p", "src/a.ts", "linux")).toEqual({
      program: "xdg-open",
      args: ["/p/src/a.ts"],
    });
  });
});

describe("symbolPath / fileLocation", () => {
  test("symbolPath qualifies symbols and leaves files bare", () => {
    expect(symbolPath({ kind: "function", filePath: "src/a.ts", label: "foo", line: 3 })).toBe(
      "src/a.ts#foo",
    );
    expect(symbolPath({ kind: "file", filePath: "src/a.ts", label: "a.ts", line: 0 })).toBe(
      "src/a.ts",
    );
  });
  test("fileLocation appends the line when known", () => {
    expect(fileLocation({ filePath: "src/a.ts", line: 12 })).toBe("src/a.ts:12");
    expect(fileLocation({ filePath: "src/a.ts", line: 0 })).toBe("src/a.ts");
  });
});
