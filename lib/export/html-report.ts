// Build a self-contained HTML architecture report: summary stats, the graph as
// inline SVG, and the detected insights. No external assets or scripts — it
// opens anywhere. Pure: the caller supplies the SVG and insights (and a
// timestamp, so the function stays deterministic for tests).

import type { GraphModel } from "../graph/types";
import type { Insight } from "../graph/insights";

export interface HtmlReportInput {
  projectName: string;
  graph: GraphModel;
  /** SVG markup from lib/export/svg.ts (embedded inline). */
  svg: string;
  insights: Insight[];
  /** Human-readable generation time (passed in for determinism). */
  generatedAt: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function statRows(pairs: [string, number][]): string {
  if (pairs.length === 0) return '<span class="muted">—</span>';
  return pairs.map(([k, v]) => `<span class="chip">${esc(k)} <b>${v}</b></span>`).join(" ");
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; color: #1f2933; background: #f8fafc; }
header { padding: 24px 32px; border-bottom: 1px solid #e2e8f0; background: #fff; }
h1 { margin: 0 0 4px; font-size: 20px; }
.muted { color: #64748b; }
main { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
section { margin-bottom: 32px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
.chip { display: inline-block; padding: 2px 8px; margin: 2px; border-radius: 6px; background: #eef2f7; font-size: 13px; }
.figure { border: 1px solid #e2e8f0; border-radius: 12px; overflow: auto; background: #fff; }
.figure svg { display: block; max-width: 100%; height: auto; }
.insight { padding: 8px 12px; border-left: 3px solid #f59e0b; margin: 6px 0; background: #fff; border-radius: 0 6px 6px 0; }
.insight.warning { border-color: #ef4444; }
.insight .title { font-weight: 600; }
.insight .detail { color: #64748b; font-size: 13px; }
`;

/** Render a standalone HTML architecture report. */
export function toHTMLReport(input: HtmlReportInput): string {
  const { projectName, graph, svg, insights, generatedAt } = input;
  const fileCount = graph.nodes.filter((n) => n.kind === "file").length;

  const insightHtml = insights.length
    ? insights
        .map(
          (i) =>
            `<div class="insight ${i.severity}"><div class="title">${esc(i.title)}</div>` +
            `<div class="detail">${esc(i.detail)}</div></div>`,
        )
        .join("\n")
    : '<p class="muted">No architectural issues detected.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyGraph report — ${esc(projectName)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${esc(projectName)}</h1>
  <div class="muted">PolyGraph architecture report · ${esc(generatedAt)}</div>
</header>
<main>
  <section>
    <h2>Summary</h2>
    <p>
      <span class="chip">${graph.nodes.length} nodes</span>
      <span class="chip">${graph.edges.length} relationships</span>
      <span class="chip">${fileCount} files</span>
    </p>
    <p><strong>By node kind:</strong><br>${statRows(countBy(graph.nodes, (n) => n.kind))}</p>
    <p><strong>By relationship:</strong><br>${statRows(countBy(graph.edges, (e) => e.kind))}</p>
  </section>
  <section>
    <h2>Architecture graph</h2>
    <div class="figure">${svg}</div>
  </section>
  <section>
    <h2>Insights (${insights.length})</h2>
    ${insightHtml}
  </section>
</main>
</body>
</html>
`;
}
