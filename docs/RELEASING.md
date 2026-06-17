# Releasing PolyGraph

The desktop app is built cross-platform by `.github/workflows/release.yml`, which
runs on a push to the **`release`** branch or a **`v*`** tag. Per-OS it builds the
native `analyzer-core` addon, compiles the sidecar, and runs `tauri build`.

```
git tag v0.1.0 && git push origin v0.1.0     # → draft GitHub Release with installers
# or: push the `release` branch              # → installers as workflow artifacts
```

## Signing & auto-update

Bundles are currently **unsigned**, and the app ships **no auto-updater**. CI needs
no signing secrets. Installers build and run on all three platforms; on Windows and
macOS users see an OS "unknown publisher" warning, which is expected for unsigned
builds.

Re-introducing auto-update later means: re-adding `tauri-plugin-updater` /
`tauri-plugin-process`, `createUpdaterArtifacts` + a `plugins.updater` block in
`src-tauri/tauri.conf.json`, a signing keypair, and the `TAURI_SIGNING_PRIVATE_KEY`
/ `APPLE_*` env wiring in `release.yml`. See the Tauri updater and code-signing
guides when that time comes.
