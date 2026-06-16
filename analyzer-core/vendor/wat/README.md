# Vendored tree-sitter-wat grammar

Generated parser for the WebAssembly text format (`.wat`), vendored from
https://github.com/wasm-lsp/tree-sitter-wasm (the `wat` grammar) because it is
not published as a crate. Only `src/parser.c` + `src/tree_sitter/parser.h` are
needed (no external scanner). ABI/LANGUAGE_VERSION 13 — loads in tree-sitter 0.22.
Compiled by build.rs via the `cc` crate. License: per the upstream repo (MIT).
