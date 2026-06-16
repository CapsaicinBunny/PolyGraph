// Compile the analysis sidecar into the target-triple-named binary Tauri expects
// as an externalBin (src-tauri/binaries/polygraph-sidecar-<triple>[.exe]). Used
// locally and in release CI before `tauri build`.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

let rustcOutput;
try {
  rustcOutput = execSync("rustc -vV").toString();
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
mkdirSync("src-tauri/binaries", { recursive: true });
const out = `src-tauri/binaries/polygraph-sidecar-${triple}${ext}`;

try {
  execSync(`bun build --compile sidecar/server.ts --outfile "${out}"`, { stdio: "inherit" });
} catch {
  console.error(
    `Failed to compile the sidecar to ${out}. Is bun installed and sidecar/server.ts present?`,
  );
  process.exit(1);
}
console.log(`Built sidecar → ${out}`);
