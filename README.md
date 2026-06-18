<div align="center">

<img src="./public/polygraph-icon.svg" alt="PolyGraph" width="92" height="92" />

# PolyGraph

**Explore, audit, enforce, and compare software architecture across 26 languages.**

[![CI](https://github.com/CapsaicinBunny/PolyGraph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CapsaicinBunny/PolyGraph/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue)](#license)
&nbsp;
![Rust](https://img.shields.io/badge/analysis%20core-Rust-DEA584?logo=rust&logoColor=white)
![WebGPU](https://img.shields.io/badge/renderer-WebGPU%20·%20Vello-005A9C)
![Languages](https://img.shields.io/badge/languages-26-8B5CF6)
![Local](https://img.shields.io/badge/100%25-local-16A34A)

</div>

Point PolyGraph at a project folder and it builds an interactive node graph of its modules, types,
functions, and the relationships between them — imports, calls, inheritance, instantiation,
composition, dependency injection, JSX renders. Then go further: trace impact, enforce architecture
rules in CI, diff two revisions, query the graph, export it, and jump to the source. Runs **entirely
locally** — nothing is uploaded.

Supports TypeScript/JavaScript, Python, Java, Kotlin, Rust, Go, Scala, C#, F#, C, C++, Objective-C,
Swift, Zig, Haskell, Ruby, PHP, Bash, Lua, Dart, Julia, R, Nix, OCaml, SQL, and WebAssembly text.

<div align="center">

<!--
  Replace docs/screenshots/demo.gif with a short (~10s) screen capture of the core loop:
  select a node → blast radius (impact) → source evidence on an edge → open in editor.
-->
<img src="docs/screenshots/demo.gif" alt="PolyGraph: select node → blast radius → source evidence → open in editor" width="100%" />

</div>

## What you can do

|                       |                                                                               |
| --------------------- | ----------------------------------------------------------------------------- |
| 🔎 **Explore**        | Interactive GPU graph, smart layout, search, filters, focus mode              |
| 🧭 **Analyze impact** | Dependencies, dependents, shortest path, blast radius, architectural insights |
| 🛡️ **Enforce**        | Architecture rules in CI (`polygraph check`) with SARIF output                |
| 🔀 **Compare**        | Diff two revisions / the working tree (`polygraph diff`)                      |
| 🗂️ **Abstract**       | Package- and workspace-level graphs from manifests                            |
| 🧮 **Query**          | A small query language for selecting and isolating subgraphs                  |
| 📤 **Export**         | DOT, GraphML, Mermaid, JSON, SVG, standalone HTML report                      |
| ✏️ **Open in editor** | Inline source preview + jump to the exact line in VS Code / JetBrains         |

Edges are **type-resolved** for TS/JS and carry evidence (file · line · column · confidence); other
languages resolve by name via tree-sitter. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how
it works.

## Install

PolyGraph ships as a **desktop app** for Windows, macOS, and Linux — no toolchain required.

1. Download the latest installer from the
   [**Releases**](https://github.com/CapsaicinBunny/PolyGraph/releases) page (Windows `.msi`/`.exe`,
   macOS `.dmg`, Linux `.AppImage`/`.tar.gz`).
2. Install and open it. Builds are **unsigned**, so Windows ("unknown publisher") and macOS
   (Gatekeeper) warn on first launch — allow it to run. Optionally verify against the release's
   `SHA256SUMS-*.txt`.
3. Paste an absolute project folder path into **Scan a folder** and explore. The folder is read
   directly from disk; nothing is uploaded.

> The graph canvas is GPU-rendered (WebGPU), drawn through the system webview.

## Documentation

- [**ARCHITECTURE.md**](docs/ARCHITECTURE.md) — how it works: kernel, providers, native core, layout, renderer
- [**CLI.md**](docs/CLI.md) — `polygraph check` / `diff`, rule schema, options
- [**BENCHMARKS.md**](docs/BENCHMARKS.md) — performance + golden-graph suite
- [**RELEASING.md**](docs/RELEASING.md) — the cross-platform release build
- [**SECURITY.md**](SECURITY.md) — reporting + tracked advisories

## Development

End users just [install the app](#install). To build from source or run the web/CLI version you
need [Bun](https://bun.sh) (and a Rust toolchain only to rebuild the native `analyzer-core` /
`vello-renderer` — prebuilt artifacts are committed).

```bash
bun install
bun run dev        # Next dev server (:3003) + analysis sidecar (:4319)
bun test           # unit tests
bun run lint       # oxlint   ·   bun run format — oxfmt
bun run bench      # performance + golden-graph suite

# CLI (from source) — the same multi-language kernel:
bun run cli/index.ts check .     # architecture rules   (alias: bun run check)
bun run cli/index.ts diff .      # graph diff vs. HEAD   (alias: bun run diff)
```

> The web version needs a WebGPU-capable browser (recent Chrome/Edge). The package is
> `"private": true`, so the `polygraph` CLI runs from this repo / the desktop app, not from a
> registry. Desktop installers are built by CI — see [docs/RELEASING.md](docs/RELEASING.md).

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for
inclusion in this project by you, as defined in the Apache-2.0 license, shall be dual
licensed as above, without any additional terms or conditions.
