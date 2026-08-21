#!/usr/bin/env bun
// PolyGraph MCP server (stdio transport). Exposes the existing code-graph analysis
// library as read-only tools so an MCP client (e.g. an AI agent) can scan and
// explore a codebase's structure. All diagnostics go to STDERR — STDOUT is
// reserved for the MCP JSON-RPC protocol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// `with { type: "text" }` yields the file's contents as a string (verified at
// runtime), but Bun's ambient declaration types every *.html import as its bundler's
// HTMLBundle regardless of the import attribute — hence the cast.
import scanWidgetHtmlBundle from "./widgets/polygraph-scan-widget.html" with { type: "text" };
import { errMsg, histText } from "./format";
import { telemetry } from "./telemetry";
import * as ops from "./operations";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const pathArg = z.string().describe("Absolute path to the project root.");

// Shared output shapes.
const briefNode = {
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  filePath: z.string(),
  line: z.number(),
};
// polygraph_node returns a library GraphNode verbatim, so this schema must track
// GraphNode exactly. Zod publishes `additionalProperties: false`, and the SDK CLIENT
// validates against the published schema — so a field missing here is not a lax
// server that strips it, it is a hard client-side rejection of every response that
// carries it. `facets` was added by the dimension-spine work and is populated for any
// node with a role/env/runtime or a non-default category (a third of nodes in a React
// codebase). `mcp/server.test.ts` pins the two in sync.
const fullNode = z.object({
  ...briefNode,
  parentFile: z.string(),
  role: z.string().optional(),
  category: z.string().optional(),
  environment: z.string().optional(),
  runtimes: z.array(z.string()).optional(),
  externalKind: z.string().optional(),
  version: z.string().optional(),
  dependencyType: z.string().optional(),
  facets: z.record(z.string(), z.array(z.string())).optional(),
});

/** Echoed by every tool that reads a cached scan — see CachedScan.scannedAt. */
const scannedAt = z
  .number()
  .describe("Epoch ms of the scan these results came from; re-run polygraph_scan after editing.");

/**
 * Run an operation, recording it (and its timing) on the telemetry bus so the
 * polygraph_logs tool can tail live activity. Errors are logged, then rethrown
 * (the SDK turns the rethrow into an MCP isError response). Exported for tests.
 */
export async function instrument<T>(
  tool: string,
  fn: () => Promise<T>,
  summary: (res: T) => Record<string, unknown>,
  args?: Record<string, unknown>,
): Promise<T> {
  const t0 = performance.now();
  let res: T;
  try {
    res = await fn();
  } catch (err) {
    // Record timing on failures too: without this the histograms silently exclude
    // the slowest calls (the ones that died), so a p95 used to diagnose "why is this
    // slow" is computed only over the calls that succeeded.
    telemetry.metric(`mcp.${tool}.ms`, Math.round(performance.now() - t0));
    telemetry.event(
      "analysis",
      `mcp.${tool}.error`,
      {
        // Log the arguments: the SDK flattens errors to `message` alone, so this is
        // the last place the failing inputs can still be recovered from.
        ...(args ? { args } : {}),
        message: errMsg(err),
        ...(err instanceof Error && err.cause !== undefined ? { cause: errMsg(err.cause) } : {}),
        ...(err instanceof Error && err.stack ? { stack: err.stack.slice(0, 2000) } : {}),
      },
      "error",
    );
    throw err;
  }
  // Outside the try on purpose: `summary` is instrumentation, and a throw in it must
  // not convert an operation that already succeeded into an isError response.
  const ms = Math.round(performance.now() - t0);
  try {
    telemetry.metric(`mcp.${tool}.ms`, ms);
    telemetry.event("analysis", `mcp.${tool}`, { ...summary(res), ms });
  } catch (err) {
    telemetry.event("analysis", `mcp.${tool}.summary-failed`, { message: errMsg(err) }, "warn");
  }
  return res;
}

/** Build the PolyGraph MCP server with all tools registered (no transport yet). */
export function createServer(): McpServer {
  const server = new McpServer({ name: "polygraph", version: "0.1.0" });

  server.registerTool(
    "polygraph_scan",
    {
      title: "Scan a project",
      description:
        "Analyze a local project directory and return a graph summary: file/node/edge counts, node-kind and edge-kind histograms, the edge-confidence mix (exact/inferred/ambiguous), and detected packages. Run this first — it caches the analysis so follow-up tools on the same `path` are fast.",
      inputSchema: { path: pathArg },
      outputSchema: {
        root: z.string(),
        scannedAt,
        fileCount: z.number(),
        skipped: z.number(),
        nodeCount: z.number(),
        edgeCount: z.number(),
        parseWarnings: z.number(),
        parseErrors: z
          .array(z.object({ filePath: z.string(), message: z.string() }))
          .describe("The files behind parseWarnings; their symbols are missing from the graph."),
        unresolved: z.number(),
        nodeKinds: z.record(z.string(), z.number()),
        edgeKinds: z.record(z.string(), z.number()),
        edgeConfidence: z.record(z.string(), z.number()),
        packagesTotal: z.number(),
        packages: z
          .array(z.object({ id: z.string(), ecosystem: z.string() }))
          .describe("Capped at 100 — compare with packagesTotal."),
        scanMs: z.number(),
        analyzeMs: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ path }) => {
      const r = await instrument(
        "scan",
        () => ops.scanSummary(path),
        (res) => ({
          root: res.root,
          nodes: res.nodeCount,
          edges: res.edgeCount,
        }),
        { path },
      );
      const worst = r.parseErrors
        .slice(0, 3)
        .map((e) => e.filePath)
        .join(", ");
      const text =
        `Scanned ${r.root}: ${r.fileCount} files → ${r.nodeCount} nodes, ${r.edgeCount} edges ` +
        `(${r.parseWarnings} parse warnings, ${r.unresolved} unresolved refs). ` +
        `Node kinds: ${histText(r.nodeKinds)}. Edge kinds: ${histText(r.edgeKinds)}. ` +
        `Confidence: ${histText(r.edgeConfidence)}. ${r.packagesTotal} package(s).` +
        (r.parseWarnings > 0
          ? ` Symbols from ${r.parseWarnings} unparseable file(s) are MISSING from the graph (e.g. ${worst}) — dependency answers may be incomplete.`
          : "");
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_query",
    {
      title: "Query the graph",
      description:
        "Run a PolyGraph query against a scanned project and return matching nodes. Query syntax: field matches (kind:class, path:**/hooks/*.ts, language:rust, environment:client, category:ui), boolean operators (AND, OR, NOT), degree metrics (outgoing >= 5, incoming > 10, calls >= 3, cycle:true), and path flow (environment:client -> environment:server).",
      inputSchema: {
        path: pathArg,
        query: z
          .string()
          .describe('The query, e.g. "kind:class AND path:**/models/*" or "incoming > 10".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max nodes to return (default 50)."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Skip this many matches — page with offset += limit while hasMore is true."),
      },
      outputSchema: {
        query: z.string(),
        scannedAt,
        matchCount: z.number(),
        returned: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
        empty: z.boolean(),
        error: z.string().optional(),
        unknownFields: z
          .array(z.string())
          .optional()
          .describe(
            "Unrecognized query fields — 0 matches here means no such FIELD, not no such code.",
          ),
        nodes: z.array(z.object(briefNode)),
      },
      annotations: READ_ONLY,
    },
    async ({ path, query, limit, offset }) => {
      const r = await instrument(
        "query",
        () => ops.queryNodes(path, query, limit, offset),
        (res) => ({
          query: res.query,
          matches: res.matchCount,
        }),
        { path, query, limit, offset },
      );
      const unknown = r.unknownFields?.length
        ? ` WARNING: unrecognized field(s) ${r.unknownFields.map((f) => `"${f}"`).join(", ")} — these fell back to a plain text match, so this is probably not the question you asked. Valid fields include kind, path, language, package, environment, category, role, incoming, outgoing, calls, cycle.`
        : "";
      const text = r.error
        ? `Query error: ${r.error}`
        : `${r.matchCount} node(s) match "${r.query}"${r.empty ? " (empty query — no constraints)" : ""}; showing ${r.returned} from offset ${r.offset}${r.hasMore ? " (more available)" : ""}.${unknown}`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_node",
    {
      title: "Inspect a node",
      description:
        "Return a node's attributes plus its dependencies (outgoing edges) and dependents (incoming edges), each with the edge kind, the other endpoint, an occurrence count, and a representative confidence. Use polygraph_query to discover node ids first.",
      inputSchema: {
        path: pathArg,
        id: z
          .string()
          .describe('Node id, e.g. "src/app.ts" (file) or "src/app.ts#handler" (symbol).'),
      },
      outputSchema: {
        node: fullNode,
        scannedAt,
        dependencyCount: z.number(),
        dependentCount: z.number(),
        dependencies: z.array(
          z.object({
            kind: z.string(),
            target: z.string(),
            targetLabel: z.string(),
            count: z.number(),
            confidence: z.string(),
          }),
        ),
        dependents: z.array(
          z.object({
            kind: z.string(),
            source: z.string(),
            sourceLabel: z.string(),
            count: z.number(),
            confidence: z.string(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ path, id }) => {
      const r = await instrument(
        "node",
        () => ops.nodeDetail(path, id),
        (res) => ({
          id: res.node.id,
          dependencies: res.dependencyCount,
          dependents: res.dependentCount,
        }),
        { path, id },
      );
      const text =
        `${r.node.kind} ${r.node.label} (${r.node.filePath}:${r.node.line}) — ` +
        `${r.dependencyCount} dependencies, ${r.dependentCount} dependents.`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_insights",
    {
      title: "List insights",
      description:
        "Return architectural insights for a scanned project: dependency cycles, fan-in/fan-out outliers, bottlenecks, orphans, client→server imports, undeclared dependencies, deep chains, instability, ambiguous and unresolved references. Optionally filter by severity.",
      inputSchema: {
        path: pathArg,
        severity: z.enum(["info", "warning"]).optional().describe("Filter to one severity."),
      },
      outputSchema: {
        scannedAt,
        total: z.number(),
        byKind: z.record(z.string(), z.number()),
        insights: z
          .array(
            z.object({
              kind: z.string(),
              severity: z.string(),
              title: z.string(),
              detail: z.string(),
              nodeIdTotal: z.number(),
              nodeIds: z.array(z.string()).describe("Capped at 10 — compare with nodeIdTotal."),
            }),
          )
          .describe("Capped at 100 — compare with total."),
      },
      annotations: READ_ONLY,
    },
    async ({ path, severity }) => {
      const r = await instrument(
        "insights",
        () => ops.listInsights(path, severity),
        (res) => ({
          total: res.total,
        }),
        { path, severity },
      );
      const text = `${r.total} insight(s): ${histText(r.byKind)}.`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_check",
    {
      title: "Check architecture rules",
      description:
        "Evaluate architecture rules from a .polygraph.yml against a scanned project and return violations (dependency rules, cycles, fan-out and dependency-depth thresholds), each with rule name, severity, message, and location. Defaults to <path>/.polygraph.yml.",
      inputSchema: {
        path: pathArg,
        config: z
          .string()
          .optional()
          .describe("Path to a .polygraph.yml (defaults to <path>/.polygraph.yml)."),
        format: z
          .enum(["json", "sarif"])
          .optional()
          .describe("'sarif' also returns a SARIF 2.1.0 log for CI upload (default json)."),
      },
      outputSchema: {
        config: z.string(),
        total: z.number(),
        errors: z.number(),
        warnings: z.number(),
        sarif: z.string().optional(),
        violations: z.array(
          z.object({
            ruleName: z.string(),
            kind: z.string(),
            severity: z.string(),
            message: z.string(),
            filePath: z.string(),
            line: z.number(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ path, config, format }) => {
      const r = await instrument(
        "check",
        () => ops.checkRules(path, config, format),
        (res) => ({
          violations: res.total,
          errors: res.errors,
        }),
        { path, config, format },
      );
      const text = `${r.total} violation(s) (${r.errors} error, ${r.warnings} warning) against ${r.config}.`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_diff",
    {
      title: "Diff two revisions",
      description:
        "Compare the code graph of two git revisions and return a structural diff: added/removed/changed node and edge counts, added/removed nodes, newly introduced cycles, and the nodes whose blast radius (transitive dependents) moved most. Requires a git repo. Omit `head` to compare a base revision against the current working tree.",
      inputSchema: {
        path: pathArg,
        base: z.string().describe("Base git revision (branch, tag, or SHA)."),
        head: z.string().optional().describe("Head revision; omit to use the working tree."),
      },
      outputSchema: {
        base: z.string(),
        head: z.string(),
        summary: z.object({
          nodesAdded: z.number(),
          nodesRemoved: z.number(),
          nodesChanged: z.number(),
          edgesAdded: z.number(),
          edgesRemoved: z.number(),
          newCycles: z.number(),
          removedCycles: z.number(),
        }),
        addedNodes: z.array(z.object(briefNode)),
        removedNodes: z.array(z.object(briefNode)),
        newCycles: z.array(z.object({ members: z.array(z.string()) })),
        blastRadiusTotal: z.number(),
        blastRadius: z
          .array(z.object({ label: z.string(), delta: z.number() }))
          .describe("The 10 largest moves — compare with blastRadiusTotal."),
      },
      annotations: READ_ONLY,
    },
    async ({ path, base, head }) => {
      const r = await instrument(
        "diff",
        () => ops.diffRevisions(path, base, head),
        (res) => ({
          base: res.base,
          head: res.head,
          nodesAdded: res.summary.nodesAdded,
          nodesRemoved: res.summary.nodesRemoved,
        }),
        { path, base, head },
      );
      const s = r.summary;
      const text =
        `${r.base} → ${r.head}: +${s.nodesAdded}/-${s.nodesRemoved} nodes (${s.nodesChanged} changed), ` +
        `+${s.edgesAdded}/-${s.edgesRemoved} edges, ${s.newCycles} new cycle(s).`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_read",
    {
      title: "Read source",
      description:
        'Read the source of a file in a scanned project (optionally a line range). Restricted to files PolyGraph analyzed under `path` — list them with polygraph_query {"query":"kind:file"}, or take a filePath from polygraph_query / polygraph_node results.',
      inputSchema: {
        path: pathArg,
        file: z.string().describe('Relative path of a scanned source file, e.g. "src/app.ts".'),
        startLine: z.number().int().min(1).optional().describe("First line, 1-based (default 1)."),
        endLine: z.number().int().min(1).optional().describe("Last line, 1-based (default end)."),
      },
      outputSchema: {
        file: z.string(),
        scannedAt,
        startLine: z.number(),
        endLine: z.number(),
        totalLines: z.number(),
        truncated: z.boolean(),
        content: z.string(),
      },
      annotations: READ_ONLY,
    },
    async ({ path, file, startLine, endLine }) => {
      const r = await instrument(
        "read",
        () => ops.readSource(path, file, startLine, endLine),
        (res) => ({ file: res.file, lines: `${res.startLine}-${res.endLine}/${res.totalLines}` }),
        { path, file, startLine, endLine },
      );
      const text = `${r.file} (lines ${r.startLine}-${r.endLine} of ${r.totalLines}${r.truncated ? ", truncated" : ""}):\n\n${r.content}`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_logs",
    {
      title: "Live logs & telemetry",
      description:
        "Read and control this server's live telemetry bus. action: 'tail' (recent events — the tools log their own activity here), 'metrics' (rolling histograms + counters, e.g. per-tool timing), 'status', or the controls 'enable' / 'disable' / 'clear'.",
      inputSchema: {
        action: z
          .enum(["tail", "metrics", "status", "enable", "disable", "clear"])
          .optional()
          .describe("Default: tail."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max events for tail (default 50)."),
      },
      // Deliberately flatter than the TS `LogsResult` union: MCP wants an object
      // schema, and passing a top-level z.discriminatedUnion here makes the SDK
      // publish an empty schema and fail the call. `events`/`metrics` are therefore
      // optional on the wire even though the TS type ties them to `action`.
      outputSchema: {
        action: z.enum(["tail", "metrics", "status", "enable", "disable", "clear"]),
        enabled: z.boolean(),
        eventCount: z.number(),
        events: z
          .array(
            z.object({
              t: z.number(),
              category: z.string(),
              level: z.string(),
              event: z.string(),
              data: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .optional(),
        metrics: z
          .object({
            histograms: z.record(
              z.string(),
              z.object({
                count: z.number(),
                total: z.number(),
                mean: z.number(),
                min: z.number(),
                max: z.number(),
                p50: z.number(),
                p95: z.number(),
                p99: z.number(),
              }),
            ),
            counters: z.record(z.string(), z.number()),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        // `clear` discards the ring buffer irrecoverably.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, limit }) => {
      const r = ops.logs(action ?? "tail", limit);
      const state = `telemetry ${r.enabled ? "on" : "off"}`;
      // `disable` also silences the error events instrument() records — the only
      // place tool failures are logged — so say so rather than let it go quiet.
      const caveat =
        r.action === "disable"
          ? " Tool errors will NOT be logged until you re-enable."
          : r.action === "clear"
            ? " Previously buffered events are gone."
            : "";
      const text =
        r.action === "tail"
          ? `${state}, ${r.eventCount} event(s); showing ${r.events.length}.`
          : r.action === "metrics"
            ? `${state}; ${Object.keys(r.metrics.histograms).length} metric series, ${Object.keys(r.metrics.counters).length} counter(s).`
            : `${state}, ${r.eventCount} event(s) (action: ${r.action}).${caveat}`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_impact",
    {
      title: "Impact of changing a node",
      description:
        'Answer "what breaks if I change this?" — the full set of transitive dependents of a node, grouped by package, by relationship kind, and the files with the most affected symbols. Use before editing or deleting something to size the blast radius.',
      inputSchema: {
        path: pathArg,
        id: z.string().describe('Node id to assess, e.g. "src/db.ts" or "src/db.ts#connect".'),
      },
      outputSchema: {
        id: z.string(),
        scannedAt,
        label: z.string(),
        total: z.number(),
        byPackage: z.record(z.string(), z.number()),
        byKind: z.record(z.string(), z.number()),
        filesAffected: z.number(),
        topFiles: z
          .array(z.object({ file: z.string(), affected: z.number() }))
          .describe("The 30 worst-hit files — compare with filesAffected."),
      },
      annotations: READ_ONLY,
    },
    async ({ path, id }) => {
      const r = await instrument(
        "impact",
        () => ops.impactOf(path, id),
        (res) => ({ id: res.id, total: res.total }),
        { path, id },
      );
      const text =
        `Changing ${r.label} affects ${r.total} node(s) across ${r.filesAffected} file(s) transitively. ` +
        `By area: ${histText(r.byPackage)}. Via: ${histText(r.byKind)}.`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "polygraph_path",
    {
      title: "Path between two nodes",
      description:
        "Explain how one node reaches another: the shortest directed dependency path plus each connecting edge and its kind. Use to understand why two parts of a codebase are coupled, or to confirm they are not (connected: false).",
      inputSchema: {
        path: pathArg,
        from: z.string().describe("Starting node id."),
        to: z.string().describe("Target node id."),
      },
      outputSchema: {
        from: z.string(),
        to: z.string(),
        scannedAt,
        connected: z.boolean(),
        hops: z.number(),
        path: z.array(z.object({ id: z.string(), label: z.string() })),
        edges: z.array(z.object({ source: z.string(), target: z.string(), kind: z.string() })),
      },
      annotations: READ_ONLY,
    },
    async ({ path, from, to }) => {
      const r = await instrument(
        "path",
        () => ops.pathBetween(path, from, to),
        (res) => ({ from: res.from, to: res.to, connected: res.connected, hops: res.hops }),
        { path, from, to },
      );
      const text = r.connected
        ? `${r.from} → ${r.to} in ${r.hops} hop(s): ${r.path.map((p) => p.label).join(" → ")}.`
        : `${r.from} does not reach ${r.to} (no directed dependency path).`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  // The scan widget, served as a resource so it is actually reachable. Imported as
  // text (rather than read from disk) so `bun run build:mcp` embeds it in the
  // compiled binary, which has no `mcp/widgets/` beside it.
  //
  // NOTE: registering the resource makes a host able to FETCH the widget; it does not
  // by itself make a host render it automatically for polygraph_scan results. That
  // binding is carried in tool `_meta` under a key the MCP Apps host defines, and is
  // deliberately not guessed here — see mcp/README.md.
  server.registerResource(
    "polygraph-scan-widget",
    "ui://polygraph/scan-widget",
    {
      title: "PolyGraph scan widget",
      description:
        "Self-rendering HTML view of a polygraph_scan result: KPI tiles, the edge-confidence mix, and node/relationship kind charts.",
      mimeType: "text/html",
    },
    (uri: URL) => ({
      contents: [
        { uri: uri.href, mimeType: "text/html", text: scanWidgetHtmlBundle as unknown as string },
      ],
    }),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[polygraph-mcp] ready on stdio");
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("[polygraph-mcp] fatal:", err);
    process.exit(1);
  });
}
