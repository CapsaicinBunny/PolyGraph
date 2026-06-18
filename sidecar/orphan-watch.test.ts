import { describe, expect, test } from "bun:test";
import { exitWhenOrphaned, processAlive } from "./orphan-watch";

/** Spawn a short-lived child, then kill it and wait for the OS to reap it. */
async function spawnAndReap(): Promise<number> {
  const child = Bun.spawn({ cmd: ["bun", "-e", "await Bun.sleep(60000)"], stdout: "ignore" });
  const pid = child.pid;
  child.kill();
  await child.exited;
  return pid;
}

describe("orphan-watch", () => {
  test("processAlive is true for the current process", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test("processAlive becomes false for a reaped child", async () => {
    const pid = await spawnAndReap();
    // The OS can take a tick to drop the pid (notably on Windows) — poll briefly.
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      alive = processAlive(pid);
      if (alive) await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  });

  test("exitWhenOrphaned ignores a missing/unset parent pid", () => {
    expect(exitWhenOrphaned(0)).toBeUndefined();
    expect(exitWhenOrphaned(1)).toBeUndefined();
  });

  test("exitWhenOrphaned fires onOrphaned once when the parent is gone", async () => {
    const pid = await spawnAndReap();
    let fired = 0;
    const timer = exitWhenOrphaned(pid, 10, () => {
      fired++;
    });
    await Bun.sleep(120);
    if (timer) clearInterval(timer);
    // Exactly once: the watchdog clears its own interval after detecting the orphan.
    expect(fired).toBe(1);
  });

  test("exitWhenOrphaned keeps watching while the parent is alive", async () => {
    let fired = 0;
    const timer = exitWhenOrphaned(process.pid, 10, () => {
      fired++;
    });
    await Bun.sleep(60);
    if (timer) clearInterval(timer);
    expect(fired).toBe(0);
  });
});
