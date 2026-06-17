# Releasing PolyGraph

The desktop app is built cross-platform by `.github/workflows/release.yml`, which
runs on a push to the **`release`** branch or a **`v*`** tag. Per-OS it builds the
native `analyzer-core` addon, compiles the sidecar, and runs `tauri build`.

```
git tag v0.1.0 && git push origin v0.1.0     # → draft GitHub Release with installers + latest.json
# or: push the `release` branch              # → installers as workflow artifacts
```

## Auto-update

The app ships the Tauri updater plugin and checks
`https://github.com/CapsaicinBunny/PolyGraph/releases/latest/download/latest.json`
on launch. `tauri-action` generates and uploads `latest.json` on tagged releases
(`includeUpdaterJson: true`).

Update packages must be **signed** with the updater key. The matching **public**
key is committed in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the
**private** key must be provided to CI.

### Required repo secrets (auto-update)

| Secret                               | Value                                    |
| ------------------------------------ | ---------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the updater private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty string if none)      |

A development keypair already exists locally (`src-tauri/.updater-private-key`,
gitignored). **For a real release, generate your own and keep the private key
safe** — losing it means you can never ship a verifiable update again:

```bash
bunx tauri signer generate -w src-tauri/.updater-private-key
# copy the printed public key into src-tauri/tauri.conf.json → plugins.updater.pubkey
# store the private key contents + password as the secrets above (never commit it)
```

## Code signing (optional — bundles are unsigned without it)

### macOS (Developer ID + notarization) — env-based, wired in `release.yml`

| Secret                                          | Value                                                   |
| ----------------------------------------------- | ------------------------------------------------------- |
| `APPLE_CERTIFICATE`                             | base64 of your Developer ID `.p12`                      |
| `APPLE_CERTIFICATE_PASSWORD`                    | `.p12` password                                         |
| `APPLE_SIGNING_IDENTITY`                        | e.g. `Developer ID Application: Name (TEAMID)`          |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID, app-specific password, team id (notarization) |

### Windows (Authenticode)

Not env-only — add to `src-tauri/tauri.conf.json` under `bundle.windows`:
`"certificateThumbprint": "..."` (machine cert) or a custom `"signCommand"`
(e.g. Azure Trusted Signing / a cloud HSM), and import the cert in the workflow
before the build step. See the Tauri Windows code-signing guide.

### Linux

AppImage/.deb ship unsigned (optionally GPG-signed). No secrets required.

## Summary

- Auto-update works once `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` are set.
- Code signing is independent and optional; without it, installers are unsigned
  (users see an OS "unknown publisher" warning) but still install and run.
