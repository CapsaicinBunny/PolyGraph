// Dev orchestrator: runs the Next dev server and the analysis sidecar together.
// The sidecar binds the fixed dev port (4319) that lib/client/api.ts targets.

const procs = [
  Bun.spawn(["bun", "run", "dev:sidecar"], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, POLYGRAPH_PORT: "4319" },
  }),
  Bun.spawn(["bun", "run", "dev:next"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
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
for (const p of procs) void p.exited.then((code) => shutdown(code));
