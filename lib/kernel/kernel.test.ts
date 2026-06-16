import { describe, expect, test } from "bun:test";
import { analyzeProject } from "./index";

describe("multi-language kernel", () => {
  test("extracts Python classes, functions, imports, calls, and inheritance", async () => {
    const files = {
      "pkg/models.py": [
        "class Base:",
        "    pass",
        "",
        "class User(Base):",
        "    def save(self):",
        "        validate()",
        "",
        "def validate():",
        "    return True",
        "",
      ].join("\n"),
      "pkg/app.py": [
        "from pkg.models import User",
        "",
        "def main():",
        "    u = User()",
        "    u.save()",
        "",
      ].join("\n"),
    };

    const { graph } = await analyzeProject(files);
    const ids = new Set(graph.nodes.map((n) => n.id));

    // file + symbol nodes (methods fold into their class, like the TS analyzer)
    expect(ids.has("pkg/models.py")).toBe(true);
    expect(ids.has("pkg/models.py#Base")).toBe(true);
    expect(ids.has("pkg/models.py#User")).toBe(true);
    expect(ids.has("pkg/models.py#validate")).toBe(true);
    expect(ids.has("pkg/app.py#main")).toBe(true);
    expect(ids.has("pkg/models.py#save")).toBe(false);

    const hasEdge = (source: string, target: string, kind: string) =>
      graph.edges.some((e) => e.source === source && e.target === target && e.kind === kind);

    // inheritance, cross-file import, and an import-resolved call
    expect(hasEdge("pkg/models.py#User", "pkg/models.py#Base", "extends")).toBe(true);
    expect(hasEdge("pkg/app.py", "pkg/models.py", "import")).toBe(true);
    expect(hasEdge("pkg/app.py#main", "pkg/models.py#User", "call")).toBe(true);
    // call within a method attributes to the enclosing class
    expect(hasEdge("pkg/models.py#User", "pkg/models.py#validate", "call")).toBe(true);
  });

  test("extracts Java classes, inheritance, imports, and instantiation", async () => {
    const files = {
      "com/app/Base.java": "package com.app;\npublic class Base {}\n",
      "com/app/Service.java": "package com.app;\npublic class Service {\n  void run() {}\n}\n",
      "com/app/User.java":
        "package com.app;\nimport com.app.Service;\npublic class User extends Base {\n  void save() { new Service().run(); }\n}\n",
    };
    const { graph } = await analyzeProject(files);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has("com/app/User.java#User")).toBe(true);
    expect(ids.has("com/app/Base.java#Base")).toBe(true);

    const hasEdge = (s: string, t: string, k: string) =>
      graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);
    // extends resolves with no import (same-package global fallback)
    expect(hasEdge("com/app/User.java#User", "com/app/Base.java#Base", "extends")).toBe(true);
    expect(hasEdge("com/app/User.java", "com/app/Service.java", "import")).toBe(true);
    expect(hasEdge("com/app/User.java#User", "com/app/Service.java#Service", "instantiates")).toBe(
      true,
    );
  });

  test("extracts Kotlin classes, top-level functions, and inheritance", async () => {
    const files = {
      "Base.kt": "open class Base\n",
      "App.kt":
        "import demo.Base\nclass User : Base() {\n  fun save() { validate() }\n}\nfun validate(): Boolean = true\n",
    };
    const { graph } = await analyzeProject(files);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has("App.kt#User")).toBe(true);
    expect(ids.has("App.kt#validate")).toBe(true);
    expect(ids.has("Base.kt#Base")).toBe(true);

    const hasEdge = (s: string, t: string, k: string) =>
      graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);
    expect(hasEdge("App.kt#User", "Base.kt#Base", "extends")).toBe(true);
    // a call inside a method attributes to the enclosing class
    expect(hasEdge("App.kt#User", "App.kt#validate", "call")).toBe(true);
  });

  test("still analyzes TypeScript through the kernel", async () => {
    const { graph } = await analyzeProject({ "a.ts": "export function foo() {}\n" });
    expect(graph.nodes.some((n) => n.id === "a.ts#foo")).toBe(true);
  });

  test("analyzes a mixed TS + Python project in one pass", async () => {
    const { graph } = await analyzeProject({
      "a.ts": "export class Widget {}\n",
      "b.py": "class Gadget:\n    pass\n",
    });
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has("a.ts#Widget")).toBe(true);
    expect(ids.has("b.py#Gadget")).toBe(true);
  });
});
