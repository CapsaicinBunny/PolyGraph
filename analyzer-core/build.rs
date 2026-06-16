use std::path::Path;

fn main() {
    napi_build::setup();

    // Compile the vendored tree-sitter-wat grammar (no published crate; see
    // vendor/wat/README.md). Only parser.c is needed — no external scanner.
    let wat = Path::new("vendor/wat/src");
    cc::Build::new()
        .include(wat)
        .file(wat.join("parser.c"))
        .warnings(false)
        .compile("tree_sitter_wat");
    println!("cargo:rerun-if-changed=vendor/wat/src/parser.c");
}
