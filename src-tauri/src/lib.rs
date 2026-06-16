use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // The analysis sidecar can't read its native addon / language packs from a
      // dev-relative path once bundled, so point it at the bundled resources.
      let resource_dir = app.path().resource_dir()?;
      let core = resource_dir.join("analyzer-core.node");
      let packs = resource_dir.join("language-packs");

      let sidecar = app
        .shell()
        .sidecar("polygraph-sidecar")?
        .env("POLYGRAPH_CORE", core.to_string_lossy().to_string())
        .env("POLYGRAPH_PACKS", packs.to_string_lossy().to_string());
      let (mut rx, child) = sidecar.spawn()?;

      // Read the sidecar's stdout; when it announces its loopback port, inject the
      // base URL so the webview's apiBase() targets it. Keep `child` alive for the
      // task's lifetime so the process isn't dropped early.
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let _child = child;
        while let Some(event) = rx.recv().await {
          if let CommandEvent::Stdout(bytes) = event {
            let line = String::from_utf8_lossy(&bytes);
            if let Some(port) = line.trim().strip_prefix("POLYGRAPH_PORT=") {
              if let Some(win) = handle.get_webview_window("main") {
                let _ = win.eval(&format!(
                  "window.__POLYGRAPH_API__='http://127.0.0.1:{}'",
                  port.trim()
                ));
              }
            }
          }
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
