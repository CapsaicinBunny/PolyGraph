// Compile the analysis sidecar into the target-triple-named binary Tauri expects
// as an externalBin (src-tauri/binaries/polygraph-sidecar-<triple>[.exe]). Used
// locally and in release CI before `tauri build`.
//
// Exported as a function so scripts/build.mjs can reuse it and learn the output
// path, rather than recompiling the same entrypoint to a second location. Still
// runnable directly: release CI calls it as `bun run tauri:sidecar`.
import { $ } from "bun";

export const exeSuffix = process.platform === "win32" ? ".exe" : "";

/** The Rust host target triple, e.g. `x86_64-pc-windows-msvc`. */
export async function hostTriple() {
  let rustcOutput;
  try {
    rustcOutput = await $`rustc -vV`.text();
  } catch {
    throw new Error("Could not run `rustc -vV` — is Rust installed and on your PATH?");
  }
  const triple = rustcOutput.match(/host:\s*(\S+)/)?.[1];
  if (!triple) {
    throw new Error("Could not determine the Rust host target triple from `rustc -vV`.");
  }
  return triple;
}

/** Compiles the sidecar and returns the path Tauri will pick it up from. */
export async function buildSidecar() {
  const out = `src-tauri/binaries/polygraph-sidecar-${await hostTriple()}${exeSuffix}`;
  try {
    await $`mkdir -p src-tauri/binaries`;
    await $`bun build --compile sidecar/server.ts --outfile ${out}`;
  } catch {
    throw new Error(
      `Failed to compile the sidecar to ${out}. Is bun installed and sidecar/server.ts present?`,
    );
  }
  return out;
}

if (import.meta.main) {
  try {
    console.log(`Built sidecar → ${await buildSidecar()}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
