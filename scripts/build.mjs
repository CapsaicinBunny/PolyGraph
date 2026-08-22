// The single build entrypoint. `bun run build` produces every shippable artifact
// under one root — dist/ — so there is one place to look:
//
//   dist/web/      the static SPA          (Next's static export)
//   dist/bin/      polygraph-sidecar, polygraph-mcp  (standalone binaries)
//   dist/desktop/  the Tauri app + installers
//
// Three other directories look like build output but are NOT, and deliberately
// stay where their toolchain requires:
//
//   out/                   Next's export target. `output: "export"` hardcodes it
//                          and `next build` has no flag to move it, so we build
//                          there and stage the result into dist/web. Next also
//                          wipes out/ on every build, which is why dist/ — not
//                          out/ — is the root: binaries left in out/ would vanish.
//   src-tauri/binaries/    A Tauri `externalBin` *input*, not an output. The
//                          filename must carry the Rust target triple so one
//                          config can cross-compile; Tauri strips it when bundling.
//   src-tauri/target/      cargo's build cache.
//
// Stage order matters: the sidecar must exist as an externalBin before `tauri
// build` runs, or bundling fails on a missing binary.
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { $ } from "bun";
import { buildSidecar, exeSuffix } from "./build-sidecar.mjs";

const DIST = "dist";

const exists = async (p) => (await stat(p).catch(() => null)) !== null;

const step = (name) => console.log(`\n▶ ${name}`);

/** Static SPA → dist/web. */
async function buildWeb() {
  step("web — next build → dist/web");
  await $`bunx next build`;
  if (!(await exists("out"))) {
    throw new Error('`next build` did not produce out/ — is `output: "export"` still set?');
  }
  await mkdir(DIST, { recursive: true });
  await rm(`${DIST}/web`, { recursive: true, force: true });
  await rename("out", `${DIST}/web`);
  console.log(`  → ${DIST}/web`);
}

/** Standalone binaries → dist/bin (sidecar also staged for Tauri). */
async function buildBin() {
  step("bin — sidecar + mcp → dist/bin");
  await mkdir(`${DIST}/bin`, { recursive: true });

  await $`bun build --compile mcp/server.ts --outfile ${DIST}/bin/polygraph-mcp`;
  console.log(`  → ${DIST}/bin/polygraph-mcp${exeSuffix}`);

  // Naming the externalBin needs `rustc -vV` for the host triple. CI runs this
  // stage bun-only to check both entrypoints still compile, so a missing Rust
  // toolchain degrades to "no Tauri staging" — loudly — instead of failing the
  // stage. dist/bin is the product either way; src-tauri/binaries is Tauri's.
  let staged = null;
  try {
    staged = await buildSidecar();
  } catch (err) {
    console.warn(`  ! ${err instanceof Error ? err.message : String(err)}`);
    console.warn("  ! Sidecar not staged as a Tauri externalBin; `build:desktop` will fail.");
  }

  if (staged === null) {
    await $`bun build --compile sidecar/server.ts --outfile ${DIST}/bin/polygraph-sidecar`;
  } else {
    // Compiled once, used twice: Tauri consumes the triple-named copy, and
    // dist/bin gets a plain-named copy for standalone use.
    await cp(staged, `${DIST}/bin/polygraph-sidecar${exeSuffix}`);
    console.log(`  → ${staged} (Tauri externalBin)`);
  }
  console.log(`  → ${DIST}/bin/polygraph-sidecar${exeSuffix}`);
}

/** Desktop app → dist/desktop. */
async function buildDesktop() {
  step("desktop — tauri build → dist/desktop");
  // `tauri build` runs tauri.conf.json's beforeBuildCommand (`bun run build:web`),
  // so the frontend is produced here rather than duplicated as a separate stage.
  // That keeps one source of truth for "the SPA must exist before bundling" — and
  // it is the same hook release CI's tauri-action relies on.
  await $`bunx tauri build`;

  const releaseDir = "src-tauri/target/release";
  // Cargo names the executable after the crate (`polygraph`), not productName.
  const appExe = `${releaseDir}/polygraph${exeSuffix}`;
  if (!(await exists(appExe))) {
    throw new Error(`tauri build reported success but ${appExe} is missing.`);
  }
  await mkdir(`${DIST}/desktop`, { recursive: true });
  await cp(appExe, `${DIST}/desktop/polygraph${exeSuffix}`);
  console.log(`  → ${DIST}/desktop/polygraph${exeSuffix}`);

  // Installers are absent when Tauri is invoked with --no-bundle (release CI does
  // this on Windows and assembles a portable zip instead), so this is optional.
  if (await exists(`${releaseDir}/bundle`)) {
    await rm(`${DIST}/desktop/bundle`, { recursive: true, force: true });
    await cp(`${releaseDir}/bundle`, `${DIST}/desktop/bundle`, { recursive: true });
    console.log(`  → ${DIST}/desktop/bundle/`);
  }
}

const stages = { web: buildWeb, bin: buildBin, desktop: buildDesktop };

const requested = process.argv.slice(2).map((a) => a.replace(/^--/, ""));
const unknown = requested.filter((r) => !(r in stages));
if (unknown.length > 0) {
  console.error(
    `Unknown build stage(s): ${unknown.join(", ")}. Expected any of: ${Object.keys(stages).join(", ")}.`,
  );
  process.exit(1);
}

// A full build is bin → desktop; desktop's beforeBuildCommand hook supplies web.
const selected = requested.length > 0 ? requested : ["bin", "desktop"];

try {
  for (const name of selected) await stages[name]();
  console.log(`\n✓ build complete → ${DIST}/`);
} catch (err) {
  console.error(`\n✗ build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
