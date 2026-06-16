// Dev orchestrator: runs the Next dev server and the analysis sidecar together.
// The sidecar binds the fixed dev port (4319) that lib/client/api.ts targets.
import { spawn } from "node:child_process";

const procs = [
  spawn("bun", ["run", "dev:sidecar"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, POLYGRAPH_PORT: "4319" },
  }),
  spawn("bun", ["run", "dev:next"], { stdio: "inherit", shell: true }),
];

let closing = false;
const shutdown = (code) => {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill();
  process.exit(code ?? 0);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const p of procs) p.on("exit", (code) => shutdown(code));
