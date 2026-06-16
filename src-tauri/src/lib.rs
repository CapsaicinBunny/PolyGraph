use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    // Logging is on in every build (Info in debug, Warn+ in release) so a
    // packaged-app failure leaves a diagnostic trail.
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(if cfg!(debug_assertions) {
          log::LevelFilter::Info
        } else {
          log::LevelFilter::Warn
        })
        .build(),
    )
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

      // Read the sidecar's output. When it announces its loopback port, inject the
      // base URL so the webview's apiBase() targets it. If it dies before doing so,
      // surface a native error dialog instead of leaving a silently broken app.
      // `child` is moved in so the process isn't dropped (killed) early.
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let _child = child;
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
              if !port_seen {
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
            _ => {}
          }
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
