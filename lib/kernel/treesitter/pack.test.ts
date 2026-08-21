import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack, packsDir } from "./pack";

const original = process.env.POLYGRAPH_PACKS;

afterEach(() => {
  if (original === undefined) delete process.env.POLYGRAPH_PACKS;
  else process.env.POLYGRAPH_PACKS = original;
});

test("uses POLYGRAPH_PACKS when set", () => {
  process.env.POLYGRAPH_PACKS = "/opt/app/resources/language-packs";
  expect(packsDir()).toBe("/opt/app/resources/language-packs");
});

test("falls back to the repo-relative default", () => {
  delete process.env.POLYGRAPH_PACKS;
  expect(packsDir()).toBe(join(process.cwd(), "language-packs"));
});

test("treats an empty POLYGRAPH_PACKS as unset", () => {
  process.env.POLYGRAPH_PACKS = "";
  expect(packsDir()).toBe(join(process.cwd(), "language-packs"));
});

// --- facet-schema loading + the catalog handshake (Phase E) -----------------
//
// buildFacetSchema is module-private, so exercise it through loadPack against a
// temp POLYGRAPH_PACKS dir. Every pack here ships the same trivial tags.scm; the
// facet behaviour under test lives entirely in pack.yaml.

let root: string;
const TAGS = "(identifier) @name\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "polygraph-packs-"));
  process.env.POLYGRAPH_PACKS = root;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a `<id>/pack.yaml` (+ tags.scm) under the temp packs root. */
async function writePack(id: string, yaml: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pack.yaml"), yaml, "utf8");
  await writeFile(join(dir, "tags.scm"), TAGS, "utf8");
}

test("a pack with no facets: block yields an empty facetSchema", async () => {
  await writePack(
    "nofacet",
    `id: nofacet
extensions: [".nf"]
grammar: nofacet
`,
  );
  const pack = await loadPack("nofacet");
  expect(pack.facetSchema).toEqual([]);
});

test("a facet missing its label throws (the handshake)", async () => {
  await writePack(
    "badfacet",
    `id: badfacet
extensions: [".bf"]
grammar: badfacet
facets:
  - key: badfacet.vis
    values:
      - { value: pub, label: Public }
`,
  );
  expect(loadPack("badfacet")).rejects.toThrow(/facet "badfacet.vis" is missing a "label"/);
});

test("a facet value missing its label throws (the handshake)", async () => {
  await writePack(
    "badvalue",
    `id: badvalue
extensions: [".bv"]
grammar: badvalue
facets:
  - key: badvalue.vis
    label: Visibility
    values:
      - { value: pub }
`,
  );
  expect(loadPack("badvalue")).rejects.toThrow(
    /facet "badvalue.vis" value "pub" is missing a "label"/,
  );
});

test("a facet missing its key throws (the handshake)", async () => {
  await writePack(
    "nokey",
    `id: nokey
extensions: [".nk"]
grammar: nokey
facets:
  - label: Visibility
    values:
      - { value: pub, label: Public }
`,
  );
  expect(loadPack("nokey")).rejects.toThrow(/a facet is missing its "key"/);
});

test("single-cardinality facet defaults to groupable single-mode grouping", async () => {
  await writePack(
    "single",
    `id: single
extensions: [".sg"]
grammar: single
facets:
  - key: single.vis
    label: Visibility
    cardinality: single
    defaultValue: private
    values:
      - { value: private, label: Private }
      - { value: pub, label: Public }
`,
  );
  const [vis] = (await loadPack("single")).facetSchema;
  expect(vis).toMatchObject({
    key: "single.vis",
    dimension: "facet",
    domain: "closed",
    cardinality: "single",
    providerIds: ["single"],
    defaultValue: "private",
    filterable: true,
    groupable: true,
    grouping: { mode: "single" },
    missing: { filter: "include", group: "unclassified" },
  });
});

test("multi-cardinality facet defaults to disabled grouping and non-groupable", async () => {
  await writePack(
    "multi",
    `id: multi
extensions: [".mg"]
grammar: multi
facets:
  - key: multi.tags
    label: Tags
    cardinality: multi
    values:
      - { value: a, label: A }
      - { value: b, label: B }
`,
  );
  const [tags] = (await loadPack("multi")).facetSchema;
  expect(tags).toMatchObject({
    key: "multi.tags",
    cardinality: "multi",
    groupable: false,
    grouping: { mode: "disabled" },
  });
});
