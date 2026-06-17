// Text serializers for a GraphModel: Graphviz DOT, GraphML, Mermaid, and raw
// PolyGraph JSON. All pure and deterministic (stable node ordering, escaped
// output) so they're easy to test and diff. Geometry-free — these describe the
// logical graph, not a rendered layout (that's lib/export/svg.ts).

import type { GraphModel } from "../graph/types";

/** Escape a string for use inside a DOT double-quoted id/label. */
function dotEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape text for XML text/attribute content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Graphviz DOT. `rankdir` mirrors the app's layout direction (LR/TB/RL/BT). */
export function toDOT(graph: GraphModel, rankdir = "LR"): string {
  const lines: string[] = [];
  lines.push("digraph PolyGraph {");
  lines.push(`  rankdir=${rankdir};`);
  lines.push('  node [shape=box, style=rounded, fontname="sans-serif"];');
  for (const n of graph.nodes) {
    lines.push(`  "${dotEscape(n.id)}" [label="${dotEscape(n.label)}"];`);
  }
  for (const e of graph.edges) {
    lines.push(
      `  "${dotEscape(e.source)}" -> "${dotEscape(e.target)}" [label="${dotEscape(e.kind)}"];`,
    );
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** GraphML (Gephi / yEd / Cytoscape). Carries label, kind, filePath, line as data keys. */
export function toGraphML(graph: GraphModel): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
  lines.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  lines.push('  <key id="kind" for="node" attr.name="kind" attr.type="string"/>');
  lines.push('  <key id="filePath" for="node" attr.name="filePath" attr.type="string"/>');
  lines.push('  <key id="line" for="node" attr.name="line" attr.type="int"/>');
  lines.push('  <key id="ekind" for="edge" attr.name="kind" attr.type="string"/>');
  lines.push('  <graph edgedefault="directed">');
  for (const n of graph.nodes) {
    lines.push(`    <node id="${xmlEscape(n.id)}">`);
    lines.push(`      <data key="label">${xmlEscape(n.label)}</data>`);
    lines.push(`      <data key="kind">${xmlEscape(n.kind)}</data>`);
    lines.push(`      <data key="filePath">${xmlEscape(n.filePath)}</data>`);
    lines.push(`      <data key="line">${n.line}</data>`);
    lines.push("    </node>");
  }
  for (const e of graph.edges) {
    lines.push(
      `    <edge source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}">` +
        `<data key="ekind">${xmlEscape(e.kind)}</data></edge>`,
    );
  }
  lines.push("  </graph>");
  lines.push("</graphml>");
  return `${lines.join("\n")}\n`;
}

/** Sanitize a label for a Mermaid quoted string (Mermaid has no escape syntax). */
function mermaidLabel(s: string): string {
  return s
    .replace(/["|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mermaid `graph` diagram. Node ids are remapped to safe aliases (n0, n1, …)
 * since Mermaid ids must be identifier-like, while the original label is shown.
 */
export function toMermaid(graph: GraphModel, direction = "LR"): string {
  const alias = new Map<string, string>();
  graph.nodes.forEach((n, i) => alias.set(n.id, `n${i}`));

  const lines: string[] = [];
  lines.push(`graph ${direction}`);
  for (const n of graph.nodes) {
    lines.push(`  ${alias.get(n.id)}["${mermaidLabel(n.label)}"]`);
  }
  for (const e of graph.edges) {
    const s = alias.get(e.source);
    const t = alias.get(e.target);
    if (!s || !t) continue; // edge to a node not in the model — skip
    lines.push(`  ${s} -->|${mermaidLabel(e.kind)}| ${t}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Raw PolyGraph JSON — the GraphModel, pretty-printed. */
export function toPolyGraphJSON(graph: GraphModel): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
