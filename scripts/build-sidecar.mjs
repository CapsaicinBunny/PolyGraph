// Compile the analysis sidecar into the target-triple-named binary Tauri expects
// as an externalBin (src-tauri/binaries/polygraph-sidecar-<triple>[.exe]). Used
// locally and in release CI before `tauri build`.
import { $ } from "bun";

let rustcOutput;
try {
  rustcOutput = await $`rustc -vV`.text();
} catch {
  console.error("Could not run `rustc -vV` — is Rust installed and on your PATH?");
  process.exit(1);
}

const triple = rustcOutput.match(/host:\s*(\S+)/)?.[1];
if (!triple) {
  console.error("Could not determine the Rust host target triple from `rustc -vV`.");
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const out = `src-tauri/binaries/polygraph-sidecar-${triple}${ext}`;

try {
  await $`mkdir -p src-tauri/binaries`;
  await $`bun build --compile sidecar/server.ts --outfile ${out}`;
} catch {
  console.error(
    `Failed to compile the sidecar to ${out}. Is bun installed and sidecar/server.ts present?`,
  );
  process.exit(1);
}
console.log(`Built sidecar → ${out}`);
