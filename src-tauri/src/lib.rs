use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the analysis sidecar so it can be killed when the app exits.
/// tauri-plugin-shell never terminates the sidecar on its own — `CommandChild` has
/// no kill-on-drop, and Tauri exits via `process::exit` — so without an explicit
/// kill the process is orphaned on window close and keeps its (often multi-GB,
/// post-scan) memory until killed by hand.
struct SidecarChild(Mutex<Option<CommandChild>>);

/// Launch an external program (e.g. an editor or the file manager) detached from
/// the app. The command + args are built by lib/editor/commands.ts on the JS
/// side; this just runs them so editor integration works cross-platform.
#[tauri::command]
fn spawn_detached(program: String, args: Vec<String>) -> Result<(), String> {
  std::process::Command::new(&program)
    .args(&args)
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("failed to launch {program}: {e}"))
}

/// Read lines [start, end] (1-based, inclusive) of a file — the source-preview
/// snippet. Bounds are clamped so out-of-range requests return what exists.
/// Reads are constrained to `root` (the scanned project) as a path-traversal
/// guard, since the requested path originates in the webview.
#[tauri::command]
fn read_source_slice(
  root: String,
  path: String,
  start: usize,
  end: usize,
) -> Result<String, String> {
  let canon_root =
    std::fs::canonicalize(&root).map_err(|e| format!("bad project root {root}: {e}"))?;
  let canon_path = std::fs::canonicalize(&path).map_err(|e| format!("read {path}: {e}"))?;
  if !canon_path.starts_with(&canon_root) {
    return Err(format!("refusing to read outside the project: {path}"));
  }
  let content = std::fs::read_to_string(&canon_path).map_err(|e| format!("read {path}: {e}"))?;
  let lines: Vec<&str> = content.lines().collect();
  let s = start.saturating_sub(1).min(lines.len());
  let e = end.min(lines.len());
  if e <= s {
    return Ok(String::new());
  }
  Ok(lines[s..e].join("\n"))
}

/// The `logs/` folder next to the executable — where both the Rust app log and the
/// webview's session telemetry are written. None if the exe path can't be resolved.
fn logs_dir() -> Option<std::path::PathBuf> {
  std::env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|dir| dir.join("logs")))
}

/// Append the webview's telemetry (NDJSON) to logs/session.ndjson, alongside the
/// app log, so the rich LOD/render trace survives a crash (the in-memory buffer is
/// otherwise lost when the page dies). `reset` truncates first — the JS flusher
/// passes it once at session start so each run starts a fresh file.
#[tauri::command]
fn append_session_log(content: String, reset: bool) -> Result<(), String> {
  let dir = logs_dir().ok_or_else(|| "cannot resolve logs dir".to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {e}"))?;
  let path = dir.join("session.ndjson");
  let mut opts = std::fs::OpenOptions::new();
  opts.create(true);
  if reset {
    opts.write(true).truncate(true);
  } else {
    opts.append(true);
  }
  use std::io::Write;
  let mut f = opts.open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
  f.write_all(content.as_bytes()).map_err(|e| format!("write {}: {e}", path.display()))?;
  Ok(())
}

/// Write `content` to an arbitrary `path` the user picked via a Save-As dialog.
/// (The path is user-chosen, so there's no project-root sandbox here, unlike the
/// read side.) Used by Export and the telemetry log download.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
  std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// Write a binary file (e.g. a PNG export) to a user-chosen `path`. The bytes
/// arrive base64-encoded since the JS->Rust bridge carries strings, not blobs.
#[tauri::command]
fn write_file_base64(path: String, base64: String) -> Result<(), String> {
  use base64::Engine;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(base64.as_bytes())
    .map_err(|e| format!("decode base64: {e}"))?;
  std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri_plugin_log::{Target, TargetKind};

  // Write the log file to a `logs/` folder right next to the executable so it's
  // easy to find while testing — instead of the buried OS app-data dir. Fall back
  // to the default app-log dir only if the exe path can't be resolved.
  let file_target = match logs_dir() {
    Some(dir) => Target::new(TargetKind::Folder { path: dir, file_name: None }),
    None => Target::new(TargetKind::LogDir { file_name: None }),
  };

  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      spawn_detached,
      read_source_slice,
      append_session_log,
      write_file,
      write_file_base64
    ])
    // Logging is on in every build (Info in debug, Warn+ in release) so a
    // packaged-app failure leaves a diagnostic trail — written to ./logs next to
    // the app plus stdout, not the OS app-data dir.
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(if cfg!(debug_assertions) {
          log::LevelFilter::Info
        } else {
          log::LevelFilter::Warn
        })
        .clear_targets()
        .target(Target::new(TargetKind::Stdout))
        .target(file_target)
        .build(),
    );

  builder
    .setup(|app| {
      // bun build --compile produces a self-contained binary; it does NOT bundle
      // the native addon or the language-pack data files. Point the sidecar at the
      // copies Tauri bundles as resources, via the env vars it reads.
      let resource_dir = app.path().resource_dir()?;
      let core = resource_dir.join("analyzer-core.node");
      let packs = resource_dir.join("language-packs");

      let sidecar = app
        .shell()
        .sidecar("polygraph-sidecar")?
        .env("POLYGRAPH_CORE", core.to_string_lossy().to_string())
        .env("POLYGRAPH_PACKS", packs.to_string_lossy().to_string());
      let (mut rx, child) = sidecar.spawn()?;
      // tauri-plugin-shell won't kill the sidecar for us, so hold the child in
      // state and terminate it from the exit handler below instead of leaking it.
      app.manage(SidecarChild(Mutex::new(Some(child))));

      // Read the sidecar's output. When it announces its loopback port, inject the
      // base URL so the webview's apiBase() targets it. If it dies before doing so,
      // surface a native error dialog instead of leaving a silently broken app.
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let mut port_seen = false;
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(bytes) => {
              let line = String::from_utf8_lossy(&bytes);
              if let Some(raw) = line.trim().strip_prefix("POLYGRAPH_PORT=") {
                let port = raw.trim();
                // Only ever inject a plain numeric port — never interpolate
                // arbitrary sidecar output into the webview's JS context.
                if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
                  match handle.get_webview_window("main") {
                    Some(win) => {
                      if let Err(e) =
                        win.eval(&format!("window.__POLYGRAPH_API__='http://127.0.0.1:{port}'"))
                      {
                        log::error!("failed to inject sidecar API base: {e}");
                      } else {
                        port_seen = true;
                      }
                    }
                    None => {
                      log::error!("webview 'main' not found; cannot set sidecar API base");
                    }
                  }
                }
              }
            }
            CommandEvent::Stderr(bytes) => {
              log::warn!("sidecar: {}", String::from_utf8_lossy(&bytes).trim());
            }
            CommandEvent::Terminated(payload) => {
              if port_seen {
                // The sidecar died AFTER announcing its port — a Bun crash/exit mid-session.
                // Scanning is broken until the app restarts; record it here (the webview also
                // logs the resulting scan failures via telemetry → session.ndjson).
                log::error!(
                  "sidecar terminated mid-session (code {:?}, signal {:?})",
                  payload.code,
                  payload.signal
                );
              } else {
                log::error!("sidecar exited before reporting a port (code {:?})", payload.code);
                handle
                  .dialog()
                  .message(
                    "PolyGraph's analysis engine failed to start, so scanning won't work. \
                     Try reinstalling; if it keeps happening, please file an issue.",
                  )
                  .title("PolyGraph")
                  .kind(MessageDialogKind::Error)
                  .show(|_| {});
              }
              break;
            }
            CommandEvent::Error(err) => {
              // An I/O error on the sidecar's pipe (distinct from the process exiting).
              log::error!("sidecar pipe error: {err}");
            }
            _ => {}
          }
        }
      });

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Kill the sidecar when the app exits so it can't outlive the window and
      // strand its memory. `RunEvent::Exit` is the final teardown hook.
      if let tauri::RunEvent::Exit = event {
        if let Some(state) = app_handle.try_state::<SidecarChild>() {
          if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
              if let Err(e) = child.kill() {
                log::warn!("failed to kill sidecar on exit: {e}");
              }
            }
          }
        }
      }
    });
}
