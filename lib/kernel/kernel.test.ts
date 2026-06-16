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
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("com/app/User.java#User")).toBe("class");
    expect(byId.get("com/app/Base.java#Base")).toBe("class");
    // members now surface as their own nodes
    expect(byId.get("com/app/User.java#save")).toBe("method");

    const hasEdge = (s: string, t: string, k: string) =>
      graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);
    // extends resolves with no import (same-package global fallback)
    expect(hasEdge("com/app/User.java#User", "com/app/Base.java#Base", "extends")).toBe(true);
    expect(hasEdge("com/app/User.java", "com/app/Service.java", "import")).toBe(true);
    // the `new Service()` is inside save(), so it attributes to the method node
    expect(hasEdge("com/app/User.java#save", "com/app/Service.java#Service", "instantiates")).toBe(
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

  test("extracts Rust structs/traits/aliases/consts/macros, calls, and use imports", async () => {
    const files = {
      "shapes.rs":
        'pub trait Draw {}\npub struct Circle;\npub enum Kind { A, B }\npub union U { a: u8 }\npub type Id = u32;\npub const MAX: u32 = 10;\nstatic GREETING: &str = "hi";\nmacro_rules! shout { () => {} }\npub mod inner { pub fn helper() {} }\nimpl Draw for Circle {}\npub fn area() -> f64 { compute() }\nfn compute() -> f64 { 1.0 }\n',
      "main.rs": "use crate::shapes::Circle;\nfn main() { area(); }\n",
    };
    const { graph } = await analyzeProject(files);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    // Each Rust construct maps to its own distinct node kind.
    expect(byId.get("shapes.rs#Circle")).toBe("struct");
    expect(byId.get("shapes.rs#U")).toBe("union");
    expect(byId.get("shapes.rs#Kind")).toBe("enum");
    expect(byId.get("shapes.rs#Draw")).toBe("trait");
    expect(byId.get("shapes.rs#Id")).toBe("type");
    expect(byId.get("shapes.rs#MAX")).toBe("constant");
    expect(byId.get("shapes.rs#GREETING")).toBe("constant");
    expect(byId.get("shapes.rs#shout")).toBe("macro");
    expect(byId.get("shapes.rs#inner")).toBe("module");
    expect(byId.get("shapes.rs#area")).toBe("function");
    // a module is non-absorbing: items inside `mod inner` stay their own nodes
    expect(byId.get("shapes.rs#helper")).toBe("function");

    const hasEdge = (s: string, t: string, k: string) =>
      graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);
    expect(hasEdge("main.rs", "shapes.rs", "import")).toBe(true);
    expect(hasEdge("main.rs#main", "shapes.rs#area", "call")).toBe(true);
    expect(hasEdge("shapes.rs#area", "shapes.rs#compute", "call")).toBe(true);
  });

  test("extracts Go types, methods, consts, and same-package calls", async () => {
    const files = {
      "model.go":
        'package model\nconst Version = "v1"\ntype User struct { Name string }\ntype Store interface { Save() }\nfunc NewUser() *User { return validate() }\nfunc validate() *User { return nil }\nfunc (u User) Greet() string { return "hi" }\n',
    };
    const { graph } = await analyzeProject(files);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("model.go#User")).toBe("struct");
    expect(byId.get("model.go#Store")).toBe("interface");
    expect(byId.get("model.go#NewUser")).toBe("function");
    expect(byId.get("model.go#Version")).toBe("constant"); // package-level const
    expect(byId.get("model.go#Greet")).toBe("method"); // method (distinct kind)
    // same-package call resolves with no import
    expect(
      graph.edges.some(
        (e) =>
          e.source === "model.go#NewUser" && e.target === "model.go#validate" && e.kind === "call",
      ),
    ).toBe(true);
  });

  test("extracts Scala classes, objects, traits, and inheritance", async () => {
    const files = {
      "Shapes.scala":
        "trait Drawable { def draw(): Unit }\nclass Circle(r: Double) extends Drawable {\n  def draw(): Unit = ()\n}\nobject Main\n",
    };
    const { graph } = await analyzeProject(files);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("Shapes.scala#Drawable")).toBe("trait");
    expect(byId.get("Shapes.scala#Circle")).toBe("class");
    expect(byId.get("Shapes.scala#Main")).toBe("object");
    expect(
      graph.edges.some(
        (e) =>
          e.source === "Shapes.scala#Circle" &&
          e.target === "Shapes.scala#Drawable" &&
          e.kind === "extends",
      ),
    ).toBe(true);
  });

  test("extracts JSON/JSONC top-level keys as properties", async () => {
    const { graph } = await analyzeProject({
      "package.json": '{ "name": "demo", "scripts": { "build": "x" }, "dependencies": {} }\n',
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("package.json#name")).toBe("property");
    expect(byId.get("package.json#scripts")).toBe("property");
    expect(byId.get("package.json#dependencies")).toBe("property");
    // nested keys (e.g. "build") are not surfaced — only top-level
    expect(byId.has("package.json#build")).toBe(false);
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
