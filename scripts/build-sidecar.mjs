// Compile the analysis sidecar into the target-triple-named binary Tauri expects
// as an externalBin (src-tauri/binaries/polygraph-sidecar-<triple>[.exe]). Used
// locally and in CI before `tauri build`.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const triple = execSync("rustc -vV")
  .toString()
  .match(/host:\s*(\S+)/)?.[1];
if (!triple) {
  console.error("Could not determine the Rust host target triple (is rustc installed?).");
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
mkdirSync("src-tauri/binaries", { recursive: true });
const out = `src-tauri/binaries/polygraph-sidecar-${triple}${ext}`;

execSync(`bun build --compile sidecar/server.ts --outfile ${out}`, { stdio: "inherit" });
console.log(`Built sidecar → ${out}`);
