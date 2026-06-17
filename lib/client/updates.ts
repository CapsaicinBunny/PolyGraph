// Desktop auto-update. On launch (in the Tauri app only) check the configured
// updater endpoint; if a newer signed release is published, ask the user, then
// download + install + relaunch. Plugins are dynamic-imported so nothing Tauri
// is pulled into the web build.
import { isTauri } from "./env";

export async function checkForUpdates(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;

    const { ask } = await import("@tauri-apps/plugin-dialog");
    const accepted = await ask(
      `PolyGraph ${update.version} is available (you have ${update.currentVersion}). ` +
        "Download and restart to update now?",
      { title: "Update available", kind: "info" },
    );
    if (!accepted) return;

    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    // Best-effort: a missing/unreachable update endpoint must never block the
    // app. Log for diagnosis but don't surface a startup error.
    console.error("Update check failed:", err);
  }
}
