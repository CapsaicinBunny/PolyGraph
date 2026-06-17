# Releasing PolyGraph

Two workflows run in CI:

- **`ci.yml`** — typecheck / lint / format / test / build, on every **pull request** and on pushes
  to **`main`** and **`release`**.
- **`release.yml`** — the cross-platform desktop build, on a push to the **`release`** branch or a
  **`v*`** tag. Per-OS it builds the native `analyzer-core` addon, compiles the sidecar, and runs
  `tauri build`.

## Cutting a release

```
git tag v0.1.0 && git push origin v0.1.0     # → draft GitHub Release with installers
# or: push the `release` branch              # → installers as workflow artifacts
```

On a **version tag**, `release.yml` publishes a **draft** GitHub Release with the unsigned
installers for all three platforms, plus best-effort **`SHA256SUMS-<os>.txt`** checksum files.
Review the draft, paste the notes, and publish.

1. Update `version` in `package.json` (and `src-tauri/tauri.conf.json` / `Cargo.toml` if pinned).
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Wait for the three-platform build; the draft release appears with installers + checksums.
4. Set the release body from the matching notes file (e.g.
   [release-notes/v0.1.0.md](release-notes/v0.1.0.md)), confirm assets + checksums, and publish.

Keep a notes file per version under `docs/release-notes/`. Each restates the tracked **glib
0.18.5 / RUSTSEC-2024-0429** advisory (Linux-only) so Linux-bundle users are aware — see
[../SECURITY.md](../SECURITY.md).

> **Linux caveat.** The Linux desktop build pulls in the GTK3 stack (and the pinned `glib 0.18.5`);
> it has historically been the most fragile of the three. If the Linux matrix leg fails, the
> Windows and macOS installers still build and publish (the matrix is `fail-fast: false`).

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

## Publishing the CLI (optional, future)

The package is `"private": true`, so the `polygraph` CLI ships only inside this repo and the
desktop app. To enable `bunx polygraph` / `npx polygraph`, remove `"private"`, ensure the `bin`
entry and published files are correct, and publish to the registry.
