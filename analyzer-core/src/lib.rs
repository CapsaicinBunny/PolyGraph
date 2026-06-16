// Native tree-sitter analysis core for the TS Module Scanner kernel.
//
// Parses a bucket of same-language source files, runs the pack's tree-sitter
// query (the .scm authored on the JS side), extracts definitions / references /
// imports using the kernel's standard capture convention, then resolves
// references by name + imports into the universal graph IR. Returns the graph
// fragment as JSON. This replaces the web-tree-sitter (WASM) path with native
// tree-sitter for speed and to drop the grammar-ABI/version fragility.

use std::collections::{HashMap, HashSet};

use napi_derive::napi;
use serde::Serialize;
use tree_sitter::{Node, Parser, Query, QueryCursor};

#[derive(Serialize)]
struct OutNode {
    id: String,
    kind: String,
    label: String,
    #[serde(rename = "filePath")]
    file_path: String,
    line: u32,
    #[serde(rename = "parentFile")]
    parent_file: String,
    category: String,
}

#[derive(Serialize)]
struct OutEdge {
    id: String,
    source: String,
    target: String,
    kind: String,
}

#[derive(Serialize)]
struct OutError {
    #[serde(rename = "filePath")]
    file_path: String,
    message: String,
}

#[derive(Serialize)]
struct Output {
    nodes: Vec<OutNode>,
    edges: Vec<OutEdge>,
    errors: Vec<OutError>,
}

fn file_node_id(p: &str) -> String {
    p.to_string()
}
fn symbol_node_id(p: &str, name: &str) -> String {
    format!("{p}#{name}")
}
fn edge_id(s: &str, t: &str, kind: &str) -> String {
    format!("{s}->{t}:{kind}")
}

fn language_for(grammar: &str) -> Option<tree_sitter::Language> {
    match grammar {
        "python" => Some(tree_sitter_python::language()),
        "java" => Some(tree_sitter_java::language()),
        "kotlin" => Some(tree_sitter_kotlin::language()),
        "rust" => Some(tree_sitter_rust::language()),
        "go" => Some(tree_sitter_go::language()),
        _ => None,
    }
}

const REF_KINDS: [&str; 7] = [
    "call",
    "extends",
    "implements",
    "instantiates",
    "renders",
    "has",
    "injects",
];

/// Map a pack's `@definition.<suffix>` to a universal NodeKind. Unknown suffixes
/// fall back to "function". Kinds must exist in lib/graph/types.ts NodeKind.
fn map_node_kind(kind: &str) -> &'static str {
    match kind {
        "class" => "class",
        "interface" => "interface",
        "struct" => "struct",
        "trait" => "trait",
        "protocol" => "protocol",
        "enum" => "enum",
        "union" => "union",
        "record" => "record",
        "object" => "object",
        "type" => "type",
        "namespace" => "namespace",
        "module" => "module",
        "function" => "function",
        "method" => "method",
        "constructor" => "constructor",
        "accessor" => "accessor",
        "component" => "component",
        "macro" => "macro",
        "variable" => "variable",
        "constant" => "constant",
        "field" => "field",
        "property" => "property",
        "annotation" => "annotation",
        _ => "function",
    }
}

/// Kinds that become a node even when nested — types, members, macros, modules.
/// Only free functions/variables/constants are gated to the top level, so locals
/// (closures, a `let` inside a function) fold away.
fn is_always_emit(kind: &str) -> bool {
    !matches!(kind, "function" | "variable" | "constant")
}

/// Containers whose nested code folds into them (a closure or local in a function;
/// the function-level top-level check). Grouping kinds (module/namespace) are NOT
/// absorbing, so items inside a `mod` stay separate nodes.
fn is_absorbing(kind: &str) -> bool {
    matches!(
        kind,
        "class"
            | "interface"
            | "struct"
            | "trait"
            | "protocol"
            | "enum"
            | "union"
            | "record"
            | "object"
            | "method"
            | "constructor"
            | "accessor"
            | "function"
            | "component"
    )
}

struct RawSymbol {
    id: String,
    name: String,
    kind: String,
    line: u32,
}
struct RawRef {
    relation: String,
    name: String,
    source_id: String,
}
struct RawImport {
    module: String,
    name: Option<String>,
}
struct FileExtract {
    symbols: Vec<RawSymbol>,
    refs: Vec<RawRef>,
    imports: Vec<RawImport>,
}

fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    s.strip_prefix("./").unwrap_or(&s).to_string()
}

fn dir_segments(path: &str) -> Vec<&str> {
    let dir = match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    };
    dir.split('/').filter(|s| !s.is_empty()).collect()
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn text_of<'a>(node: Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

fn extract_file(file_path: &str, source: &str, parser: &mut Parser, query: &Query) -> FileExtract {
    let empty = || FileExtract { symbols: vec![], refs: vec![], imports: vec![] };
    let Some(tree) = parser.parse(source, None) else {
        return empty();
    };
    let root = tree.root_node();
    let src = source.as_bytes();
    let capture_names = query.capture_names();

    // node, kind, name, line
    let mut defs: Vec<(Node, String, String, u32)> = Vec::new();
    // relation, name, node
    let mut ref_raw: Vec<(String, String, Node)> = Vec::new();
    let mut imports: Vec<RawImport> = Vec::new();

    let mut cursor = QueryCursor::new();
    for m in cursor.matches(query, root, src) {
        let mut name_node: Option<Node> = None;
        let mut def_kind: Option<String> = None;
        let mut def_node: Option<Node> = None;
        let mut ref_rel: Option<String> = None;
        let mut ref_node: Option<Node> = None;
        let mut module_node: Option<Node> = None;
        let mut import_name: Option<String> = None;
        let mut is_import = false;

        for cap in m.captures {
            let cname = capture_names[cap.index as usize];
            let node = cap.node;
            if cname == "name" {
                name_node = Some(node);
            } else if cname == "module" {
                module_node = Some(node);
            } else if cname == "import.name" {
                import_name = Some(text_of(node, src).to_string());
            } else if cname == "import" {
                is_import = true;
            } else if let Some(rest) = cname.strip_prefix("definition.") {
                def_kind = Some(rest.to_string());
                def_node = Some(node);
            } else if let Some(rest) = cname.strip_prefix("reference.") {
                ref_rel = Some(rest.to_string());
                ref_node = Some(node);
            }
        }

        if is_import {
            if let Some(mn) = module_node {
                imports.push(RawImport {
                    module: text_of(mn, src).to_string(),
                    name: import_name,
                });
            }
        } else if let (Some(kind), Some(dn), Some(nn)) = (def_kind, def_node, name_node) {
            defs.push((
                dn,
                kind,
                text_of(nn, src).to_string(),
                dn.start_position().row as u32 + 1,
            ));
        } else if let (Some(rel), Some(rn), Some(nn)) = (ref_rel, ref_node, name_node) {
            ref_raw.push((rel, text_of(nn, src).to_string(), rn));
        }
    }

    // node id -> index into defs, for ABSORBING defs only (classes own their
    // methods; modules don't, so a function in a `mod` stays top-level).
    let mut def_index: HashMap<usize, usize> = HashMap::new();
    for (i, (node, kind, _, _)) in defs.iter().enumerate() {
        if is_absorbing(kind) {
            def_index.insert(node.id(), i);
        }
    }
    let nearest_def_above = |node: Node| -> Option<usize> {
        let mut cur = node.parent();
        while let Some(n) = cur {
            if let Some(&i) = def_index.get(&n.id()) {
                return Some(i);
            }
            cur = n.parent();
        }
        None
    };

    // A class is always a node; a function only when top-level. Others fold into
    // the nearest emitted ancestor for reference attribution.
    let mut emitted_own: HashMap<usize, String> = HashMap::new();
    let mut symbols: Vec<RawSymbol> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (node, kind, name, line) in &defs {
        let emit = is_always_emit(kind) || nearest_def_above(*node).is_none();
        if !emit {
            continue;
        }
        let id = symbol_node_id(file_path, name);
        emitted_own.insert(node.id(), id.clone());
        if seen.insert(id.clone()) {
            symbols.push(RawSymbol {
                id,
                name: name.clone(),
                kind: kind.clone(),
                line: *line,
            });
        }
    }

    let enclosing_emitted = |node: Node| -> Option<String> {
        let mut cur = Some(node);
        while let Some(n) = cur {
            if let Some(s) = emitted_own.get(&n.id()) {
                return Some(s.clone());
            }
            cur = n.parent();
        }
        None
    };

    let file_id = file_node_id(file_path);
    let refs = ref_raw
        .into_iter()
        .map(|(relation, name, node)| RawRef {
            relation,
            name,
            source_id: enclosing_emitted(node).unwrap_or_else(|| file_id.clone()),
        })
        .collect();

    FileExtract {
        symbols,
        refs,
        imports,
    }
}

fn resolve_python_module(module: &str, from_file: &str, file_set: &HashSet<&str>) -> Option<String> {
    let segments: Vec<String> = if let Some(stripped) = module.strip_prefix('.') {
        // count leading dots (module already lost one in strip_prefix)
        let extra = stripped.chars().take_while(|c| *c == '.').count();
        let dots = 1 + extra;
        let rest: Vec<&str> = module[dots..].split('.').filter(|s| !s.is_empty()).collect();
        let mut base: Vec<&str> = dir_segments(from_file);
        for _ in 1..dots {
            base.pop();
        }
        base.into_iter()
            .chain(rest)
            .map(|s| s.to_string())
            .collect()
    } else {
        module.split('.').filter(|s| !s.is_empty()).map(String::from).collect()
    };
    if segments.is_empty() {
        return None;
    }
    let path = segments.join("/");
    for cand in [format!("{path}.py"), format!("{path}/__init__.py")] {
        if file_set.contains(cand.as_str()) {
            return Some(cand);
        }
    }
    None
}

fn resolve_module(
    style: &str,
    module: &str,
    from_file: &str,
    file_set: &HashSet<&str>,
) -> Option<String> {
    match style {
        "python" => resolve_python_module(module, from_file, file_set),
        _ => None,
    }
}

fn build_graph(per_file: &HashMap<String, FileExtract>, import_style: &str) -> Output {
    let files: Vec<&String> = per_file.keys().collect();
    let file_set: HashSet<&str> = files.iter().map(|s| s.as_str()).collect();
    let mut nodes: Vec<OutNode> = Vec::new();
    let mut edges: Vec<OutEdge> = Vec::new();
    let mut symbols_by_file: HashMap<&str, HashMap<&str, &str>> = HashMap::new();

    for file in &files {
        let fid = file_node_id(file);
        nodes.push(OutNode {
            id: fid.clone(),
            kind: "file".into(),
            label: basename(file),
            file_path: (*file).clone(),
            line: 0,
            parent_file: fid.clone(),
            category: "feature".into(),
        });
        let fx = &per_file[*file];
        let mut name_to_id: HashMap<&str, &str> = HashMap::new();
        for s in &fx.symbols {
            nodes.push(OutNode {
                id: s.id.clone(),
                kind: map_node_kind(&s.kind).into(),
                label: s.name.clone(),
                file_path: (*file).clone(),
                line: s.line,
                parent_file: fid.clone(),
                category: "feature".into(),
            });
            name_to_id.entry(s.name.as_str()).or_insert(s.id.as_str());
        }
        symbols_by_file.insert(file.as_str(), name_to_id);
    }

    // By-name resolution (everything except Python's path-based imports — Java,
    // Kotlin, Rust, Go): imports map by simple symbol name and same-scope refs
    // often have no import, so build a global unique-definer index (symbol name
    // -> the single file that defines it, None if ambiguous).
    let by_name = import_style != "python";
    let mut definer: HashMap<&str, Option<&str>> = HashMap::new();
    if by_name {
        for file in &files {
            for s in &per_file[*file].symbols {
                definer
                    .entry(s.name.as_str())
                    .and_modify(|e| {
                        if *e != Some(file.as_str()) {
                            *e = None;
                        }
                    })
                    .or_insert(Some(file.as_str()));
            }
        }
    }
    let definer_file = |name: &str| -> Option<&str> {
        match definer.get(name) {
            Some(Some(f)) => Some(*f),
            _ => None,
        }
    };

    // Import edges + local-name -> source-file bindings for cross-file refs.
    let mut imported: HashMap<&str, HashMap<&str, String>> = HashMap::new();
    for file in &files {
        let fid = file_node_id(file);
        let mut binds: HashMap<&str, String> = HashMap::new();
        for imp in &per_file[*file].imports {
            let (target, bind_name): (Option<String>, Option<&str>) = if by_name {
                let simple = imp
                    .module
                    .rsplit(|c| c == '.' || c == ':' || c == '/')
                    .find(|s| !s.is_empty())
                    .unwrap_or(imp.module.as_str());
                (definer_file(simple).map(str::to_string), Some(simple))
            } else {
                (
                    resolve_module(import_style, &imp.module, file, &file_set),
                    imp.name.as_deref(),
                )
            };
            if let Some(target) = target {
                let tid = file_node_id(&target);
                edges.push(OutEdge {
                    id: edge_id(&fid, &tid, "import"),
                    source: fid.clone(),
                    target: tid,
                    kind: "import".into(),
                });
                if let Some(n) = bind_name {
                    binds.insert(n, target);
                }
            }
        }
        imported.insert(file.as_str(), binds);
    }

    for file in &files {
        let local = &symbols_by_file[file.as_str()];
        let binds = &imported[file.as_str()];
        for r in &per_file[*file].refs {
            if !REF_KINDS.contains(&r.relation.as_str()) {
                continue;
            }
            let resolve_in = |tf: &str| -> String {
                symbols_by_file
                    .get(tf)
                    .and_then(|m| m.get(r.name.as_str()))
                    .map(|id| (*id).to_string())
                    .unwrap_or_else(|| file_node_id(tf))
            };
            let target: Option<String> = if let Some(id) = local.get(r.name.as_str()) {
                Some((*id).to_string())
            } else if let Some(tf) = binds.get(r.name.as_str()) {
                Some(resolve_in(tf))
            } else if by_name {
                definer_file(r.name.as_str()).map(resolve_in)
            } else {
                None
            };
            if let Some(t) = target {
                if t != r.source_id {
                    edges.push(OutEdge {
                        id: edge_id(&r.source_id, &t, &r.relation),
                        source: r.source_id.clone(),
                        target: t,
                        kind: r.relation.clone(),
                    });
                }
            }
        }
    }

    Output {
        nodes,
        edges,
        errors: vec![],
    }
}

/// Analyze a bucket of same-language files. `files_json` is a JSON object of
/// relative path -> source text. Returns a JSON `{ nodes, edges, errors }`.
#[napi]
pub fn analyze(
    grammar: String,
    query_src: String,
    import_style: String,
    files_json: String,
) -> napi::Result<String> {
    let language = language_for(&grammar)
        .ok_or_else(|| napi::Error::from_reason(format!("unknown grammar: {grammar}")))?;
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|e| napi::Error::from_reason(format!("set_language: {e}")))?;
    let query = Query::new(&language, &query_src)
        .map_err(|e| napi::Error::from_reason(format!("query: {e:?}")))?;

    let files: HashMap<String, String> = serde_json::from_str(&files_json)
        .map_err(|e| napi::Error::from_reason(format!("bad files json: {e}")))?;

    let mut per_file: HashMap<String, FileExtract> = HashMap::new();
    for (path, source) in &files {
        let norm = norm_path(path);
        let fx = extract_file(&norm, source, &mut parser, &query);
        per_file.insert(norm, fx);
    }

    let output = build_graph(&per_file, &import_style);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}
