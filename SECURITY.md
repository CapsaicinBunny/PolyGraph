# Security Policy

PolyGraph runs **entirely locally** — it reads a folder from disk via a loopback-only Bun sidecar
and never uploads or persists your code. There is no server component and no network egress in
normal operation.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories
(**Security → Report a vulnerability** on the repository) rather than a public issue. Include
affected version/commit, reproduction steps, and impact. We aim to acknowledge within a few days.

## Supported versions

PolyGraph is pre-1.0 (alpha). Security fixes target the latest `main` and the most recent release.

## Tracked advisories

We **do not silently ignore** known advisories. Each is documented here, and if/when an automated
scanner (`cargo audit` / `cargo deny`) is added to CI, any ignore entry must carry the advisory id,
a one-line reason, and a link back to this file or the tracking issue — never a bare ignore.

### RUSTSEC-2024-0429 — `glib 0.18.5` (Linux desktop build only)

- **Advisory:** [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) /
  GHSA-wrw7-89jp-8q8g — unsoundness in `glib::VariantStrIter`, fixed in `glib ≥ 0.20.0`.
- **Where:** `src-tauri/Cargo.lock` resolves `glib 0.18.5`, pulled in transitively by
  `gtk 0.18.2` (GTK3 bindings) ← `tauri` (Linux webkit2gtk backend).
- **Scope:** **Linux desktop build only.** `glib` is **not** compiled into the Windows or macOS
  apps, and not into the web/sidecar/CLI at all.
- **Why it's pinned:** `gtk 0.18.2` is the last GTK3 binding (now unmaintained); gtk-rs moved to
  GTK4, so there is no `glib 0.20` in any GTK3 dependency tree and no backport. `cargo update -p
glib --precise 0.20.0` fails the `glib = "^0.18"` requirement.
- **Status:** **Blocked upstream** on Tauri's migration to GTK4 + WebKitGTK6. Re-evaluate when a
  Tauri release ships gtk4-rs. Tracked in
  [#4](https://github.com/CapsaicinBunny/PolyGraph/issues/4) (with the upstream Tauri/wry issue
  links). Safe to mark the corresponding Dependabot alert "no upstream fix available" with a
  reference to that issue — do not dismiss it without the reference.

This advisory is also restated in each release's notes so consumers of the Linux bundle are aware.
