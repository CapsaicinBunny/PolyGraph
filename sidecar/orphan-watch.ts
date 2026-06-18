// Self-watchdog: the sidecar exits once its parent (the Tauri app) is gone.
//
// The Rust side kills the sidecar on a normal app exit (RunEvent::Exit), but a
// crash or force-kill of the app never fires that, which would leave this process
// — and its post-scan memory (multi-GB on a large repo) — orphaned. Polling the
// parent PID is cross-platform and covers every parent-death path, including the
// ones the Rust handler can't. `process.kill(pid, 0)` doesn't actually signal; it
// only probes whether the process exists.

/** Whether a process with `pid` currently exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM (and anything else) = it exists but we can't
    // signal it — still alive, so don't treat that as gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Poll `parentPid`; once it no longer exists, stop polling and run `onOrphaned`
 * (by default, exit this process). Returns the timer, or undefined when there is
 * no real parent to watch. `onOrphaned` is injectable so the behavior is testable
 * without actually exiting.
 */
export function exitWhenOrphaned(
  parentPid: number,
  intervalMs = 3000,
  onOrphaned: () => void = () => process.exit(0),
): ReturnType<typeof setInterval> | undefined {
  // pid 0/1 aren't a meaningful parent to watch (unset, or reparented to init).
  if (!parentPid || parentPid <= 1) return undefined;
  const timer = setInterval(() => {
    if (!processAlive(parentPid)) {
      clearInterval(timer);
      onOrphaned();
    }
  }, intervalMs);
  // The watchdog must never, by itself, keep the sidecar alive.
  timer.unref?.();
  return timer;
}
