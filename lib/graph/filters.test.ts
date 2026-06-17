import { expect, test } from "bun:test";
import type { GraphModel, GraphNode } from "./types";
import {
  availableFolders,
  availableLanguages,
  DEFAULT_HIDDEN_LANGUAGES,
  fileLanguage,
  topFolderOf,
} from "./filters";

test("topFolderOf returns the first segment, or / for root files", () => {
  expect(topFolderOf("src/foo/bar.ts")).toBe("src");
  expect(topFolderOf("lib\\baz.rs")).toBe("lib");
  expect(topFolderOf("index.ts")).toBe("/");
});

test("fileLanguage maps extension to a key/label/color; JSON and unknown handled", () => {
  expect(fileLanguage("a.ts").key).toBe("TS");
  expect(fileLanguage("a.json").key).toBe("{}");
  expect(fileLanguage("a.json").label).toBe("JSON");
  expect(fileLanguage("a.unknownext").key).toBe("other");
});

test("JSON is hidden by default", () => {
  expect(DEFAULT_HIDDEN_LANGUAGES.has("{}")).toBe(true);
  expect(DEFAULT_HIDDEN_LANGUAGES.has("TS")).toBe(false);
});

function fileNode(filePath: string): GraphNode {
  return { id: filePath, kind: "file", label: filePath, filePath, line: 0, parentFile: filePath };
}

test("availableFolders + availableLanguages count file nodes", () => {
  const graph: GraphModel = {
    nodes: [
      fileNode("src/a.ts"),
      fileNode("src/b.ts"),
      fileNode("lib/c.rs"),
      fileNode("pkg.json"),
    ],
    edges: [],
  };
  expect(availableFolders(graph)).toEqual([
    { name: "src", count: 2 },
    { name: "/", count: 1 },
    { name: "lib", count: 1 },
  ]);
  const langs = availableLanguages(graph);
  expect(langs.find((l) => l.key === "TS")?.count).toBe(2);
  expect(langs.find((l) => l.key === "RS")?.count).toBe(1);
  expect(langs.find((l) => l.key === "{}")?.count).toBe(1);
});
