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

  test("extracts WebAssembly (.wat) functions, globals, and types", async () => {
    const { graph } = await analyzeProject({
      "math.wat":
        "(module\n  (type $t (func))\n  (global $count (mut i32) (i32.const 0))\n  (func $add (result i32) i32.const 0)\n)\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("math.wat#$add")).toBe("function");
    expect(byId.get("math.wat#$count")).toBe("variable");
    expect(byId.get("math.wat#$t")).toBe("type");
  });

  test("surfaces JSDoc @typedef / @callback as nodes in plain JS", async () => {
    const { graph } = await analyzeProject({
      "types.js":
        "/**\n * @typedef {Object} Point\n * @property {number} x\n */\n\n/**\n * @callback Handler\n * @param {Point} p\n */\n\nexport function noop() {}\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("types.js#Point")).toBe("type");
    expect(byId.get("types.js#Handler")).toBe("function");
  });

  test("extracts C# types, members, inheritance, and usage", async () => {
    const { graph } = await analyzeProject({
      "App.cs":
        "namespace Demo {\n  interface IShape { }\n  class Circle : IShape {\n    private int radius;\n    public int Area() { return Compute(); }\n    int Compute() { return 1; }\n  }\n  class Program { static void Main() { new Circle(); } }\n}\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("App.cs#Demo")).toBe("namespace");
    expect(byId.get("App.cs#IShape")).toBe("interface");
    expect(byId.get("App.cs#Circle")).toBe("class");
    expect(byId.get("App.cs#radius")).toBe("field");
    expect(byId.get("App.cs#Area")).toBe("method");
    const hasEdge = (s: string, t: string, k: string) =>
      graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);
    expect(hasEdge("App.cs#Circle", "App.cs#IShape", "extends")).toBe(true);
    expect(hasEdge("App.cs#Area", "App.cs#Compute", "call")).toBe(true);
    expect(hasEdge("App.cs#Main", "App.cs#Circle", "instantiates")).toBe(true);
  });

  test("extracts F# types and let-bound functions", async () => {
    const { graph } = await analyzeProject({
      "Shapes.fs":
        "module Shapes\n\ntype Shape = { Radius: float }\n\nlet area r = 1.0\nlet compute r = 2.0\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("Shapes.fs#Shape")).toBe("type");
    expect(byId.get("Shapes.fs#area")).toBe("function");
    expect(byId.get("Shapes.fs#compute")).toBe("function");
  });

  test("extracts C functions, structs, and typedefs", async () => {
    const { graph } = await analyzeProject({
      "m.c":
        "typedef struct {int x;} Pt;\nint add(int a){ return mul(a); }\nint mul(int a){ return a; }\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("m.c#Pt")).toBe("type");
    expect(byId.get("m.c#add")).toBe("function");
    expect(
      graph.edges.some(
        (e) => e.source === "m.c#add" && e.target === "m.c#mul" && e.kind === "call",
      ),
    ).toBe(true);
  });

  test("extracts C++ classes, namespaces, and functions", async () => {
    const { graph } = await analyzeProject({
      "m.cpp":
        "namespace app { class Shape { public: int area(); }; struct P {}; }\nint go(){ return 1; }\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("m.cpp#app")).toBe("namespace");
    expect(byId.get("m.cpp#Shape")).toBe("class");
    expect(byId.get("m.cpp#P")).toBe("struct");
    expect(byId.get("m.cpp#go")).toBe("function");
  });

  test("extracts Objective-C interfaces", async () => {
    const { graph } = await analyzeProject({ "V.m": "@interface Foo : Bar\n@end\n" });
    expect(graph.nodes.some((n) => n.id === "V.m#Foo" && n.kind === "class")).toBe(true);
  });

  test("extracts Swift classes/structs/enums/protocols/functions", async () => {
    const { graph } = await analyzeProject({
      "S.swift":
        "class C {}\nstruct P {}\nenum E {}\nprotocol Pr {}\nfunc area() -> Int { return 1 }\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("S.swift#C")).toBe("class");
    expect(byId.get("S.swift#P")).toBe("struct");
    expect(byId.get("S.swift#E")).toBe("enum");
    expect(byId.get("S.swift#Pr")).toBe("protocol");
    expect(byId.get("S.swift#area")).toBe("function");
  });

  test("extracts Zig functions and declarations", async () => {
    const { graph } = await analyzeProject({
      "m.zig": "const Foo = struct { x: i32 };\npub fn add(a: i32) i32 { return a; }\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("m.zig#add")).toBe("function");
    expect(byId.get("m.zig#Foo")).toBe("struct");
  });

  test("extracts Haskell data types, classes, and functions", async () => {
    const { graph } = await analyzeProject({
      "M.hs":
        "module M where\ndata Shape = Circle\nclass Draw a where\narea :: Int -> Int\narea x = x\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("M.hs#Shape")).toBe("type");
    expect(byId.get("M.hs#Draw")).toBe("interface");
    expect(byId.get("M.hs#area")).toBe("function");
  });

  test("extracts Ruby/PHP/Bash/Lua/Dart definitions", async () => {
    const { graph } = await analyzeProject({
      "a.rb": "class Animal\n  def speak; end\nend\nclass Dog < Animal\nend\n",
      "a.php": "<?php\nnamespace App;\ninterface I {}\nclass C implements I { function m(){} }\n",
      "a.sh": "build() { compile; }\ncompile() { echo hi; }\n",
      "a.lua": "function add(x) return x end\n",
      "a.dart": "class A {}\nenum E { x }\nint go() => 1;\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("a.rb#Animal")).toBe("class");
    expect(byId.get("a.rb#speak")).toBe("method");
    expect(byId.get("a.php#App")).toBe("namespace");
    expect(byId.get("a.php#I")).toBe("interface");
    expect(byId.get("a.php#m")).toBe("method");
    expect(byId.get("a.sh#build")).toBe("function");
    expect(byId.get("a.lua#add")).toBe("function");
    expect(byId.get("a.dart#A")).toBe("class");
    expect(byId.get("a.dart#E")).toBe("enum");
    expect(
      graph.edges.some(
        (e) => e.source === "a.rb#Dog" && e.target === "a.rb#Animal" && e.kind === "extends",
      ),
    ).toBe(true);
  });

  test("extracts Julia/R/Nix/OCaml definitions", async () => {
    const { graph } = await analyzeProject({
      "a.jl": "module M\nstruct Point end\nfunction area(r) end\nend\n",
      "a.r": "area <- function(r) { r }\n",
      "a.nix": "{ foo = 1; bar = 2; }\n",
      "a.ml": "module M = struct end\ntype shape = Circle\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("a.jl#M")).toBe("module");
    expect(byId.get("a.jl#Point")).toBe("struct");
    expect(byId.get("a.jl#area")).toBe("function");
    expect(byId.get("a.r#area")).toBe("function");
    expect(byId.get("a.nix#foo")).toBe("property");
    expect(byId.get("a.ml#shape")).toBe("type");
  });

  test("extracts SQL tables, columns, views, and functions", async () => {
    const { graph } = await analyzeProject({
      "schema.sql":
        "CREATE TABLE users (\n  id INT,\n  name VARCHAR(50)\n);\nCREATE VIEW active AS SELECT * FROM users;\nCREATE FUNCTION addone(a INT) RETURNS INT AS $$ SELECT a $$ LANGUAGE sql;\n",
    });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.kind]));
    expect(byId.get("schema.sql#users")).toBe("struct");
    expect(byId.get("schema.sql#id")).toBe("field");
    expect(byId.get("schema.sql#name")).toBe("field");
    expect(byId.get("schema.sql#active")).toBe("struct");
    expect(byId.get("schema.sql#addone")).toBe("function");
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
