import { describe, expect, test } from "bun:test";
import { discoverPackages } from "./index";
import { PROVIDERS } from "./providers";

function parseOne(path: string, content: string) {
  const provider = PROVIDERS.find((p) => p.matches(path));
  return provider?.parse(path, content)?.manifest;
}

describe("npm provider", () => {
  test("name + dependency sections with types", () => {
    const m = parseOne(
      "packages/api/package.json",
      JSON.stringify({
        name: "@app/api",
        dependencies: { react: "^19" },
        devDependencies: { typescript: "^5" },
      }),
    );
    expect(m?.name).toBe("@app/api");
    expect(m?.dir).toBe("packages/api");
    expect(m?.declaredDeps).toContainEqual({ name: "react", version: "^19", type: "dependency" });
    expect(m?.declaredDeps).toContainEqual({
      name: "typescript",
      version: "^5",
      type: "devDependency",
    });
  });
});

describe("cargo provider", () => {
  test("package name + dependencies (string and inline table)", () => {
    const m = parseOne(
      "crates/core/Cargo.toml",
      `[package]\nname = "core"\n[dependencies]\nserde = "1"\ntokio = { version = "1.3" }`,
    );
    expect(m?.name).toBe("core");
    expect(m?.declaredDeps.map((d) => d.name).sort()).toEqual(["serde", "tokio"]);
  });
});

describe("go provider", () => {
  test("module name + require block", () => {
    const m = parseOne(
      "go.mod",
      `module github.com/acme/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/x/y v1.0.0\n)`,
    );
    expect(m?.name).toBe("github.com/acme/app");
    expect(m?.declaredDeps[0].name).toBe("github.com/x/y");
  });
});

describe("python provider", () => {
  test("PEP 621 project name + dependencies", () => {
    const m = parseOne(
      "pyproject.toml",
      `[project]\nname = "mypkg"\ndependencies = ["requests>=2.0", "flask"]`,
    );
    expect(m?.name).toBe("mypkg");
    expect(m?.declaredDeps.map((d) => d.name)).toEqual(["requests", "flask"]);
  });
});

describe("maven provider", () => {
  test("project artifactId (not parent) + dependency artifacts", () => {
    const m = parseOne(
      "pom.xml",
      `<project><parent><artifactId>parent-pom</artifactId></parent>
       <artifactId>my-service</artifactId>
       <dependencies>
         <dependency><groupId>g</groupId><artifactId>guava</artifactId><version>33</version></dependency>
       </dependencies></project>`,
    );
    expect(m?.name).toBe("my-service");
    expect(m?.declaredDeps).toContainEqual({ name: "guava", version: "33", type: "dependency" });
  });
});

describe("discoverPackages — workspace membership", () => {
  test("packages under a workspace root inherit its workspace", () => {
    const pkgs = discoverPackages({
      "Cargo.toml": `[workspace]\nmembers = ["crates/core", "crates/util"]`,
      "crates/core/Cargo.toml": `[package]\nname = "core"`,
      "crates/util/Cargo.toml": `[package]\nname = "util"`,
      "package.json": JSON.stringify({ name: "frontend" }),
    });
    const byName = new Map(pkgs.map((p) => [p.name, p]));
    // The virtual workspace root takes its directory's name ("root" for the repo root).
    expect(byName.get("core")?.workspace).toBe(byName.get("root")?.name ?? "root");
    expect(byName.get("util")?.workspace).toBe("root");
    expect(byName.get("frontend")?.workspace).toBeUndefined();
  });
});
