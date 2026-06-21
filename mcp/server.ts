#!/usr/bin/env bun
// PolyGraph MCP server (stdio transport). Exposes the existing code-graph analysis
// library as read-only tools so an MCP client (e.g. an AI agent) can scan and
// explore a codebase's structure. All diagnostics go to STDERR — STDOUT is
// reserved for the MCP JSON-RPC protocol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { histText } from "./format";
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
});

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
        fileCount: z.number(),
        skipped: z.number(),
        nodeCount: z.number(),
        edgeCount: z.number(),
        parseWarnings: z.number(),
        unresolved: z.number(),
        nodeKinds: z.record(z.string(), z.number()),
        edgeKinds: z.record(z.string(), z.number()),
        edgeConfidence: z.record(z.string(), z.number()),
        packages: z.array(z.object({ id: z.string(), ecosystem: z.string() })),
        scanMs: z.number(),
        analyzeMs: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ path }) => {
      const r = await ops.scanSummary(path);
      const text =
        `Scanned ${r.root}: ${r.fileCount} files → ${r.nodeCount} nodes, ${r.edgeCount} edges ` +
        `(${r.parseWarnings} parse warnings, ${r.unresolved} unresolved refs). ` +
        `Node kinds: ${histText(r.nodeKinds)}. Edge kinds: ${histText(r.edgeKinds)}. ` +
        `Confidence: ${histText(r.edgeConfidence)}. ${r.packages.length} package(s).`;
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
      },
      outputSchema: {
        query: z.string(),
        matchCount: z.number(),
        returned: z.number(),
        empty: z.boolean(),
        error: z.string().optional(),
        nodes: z.array(z.object(briefNode)),
      },
      annotations: READ_ONLY,
    },
    async ({ path, query, limit }) => {
      const r = await ops.queryNodes(path, query, limit);
      const text = r.error
        ? `Query error: ${r.error}`
        : `${r.matchCount} node(s) match "${r.query}"${r.empty ? " (empty query — no constraints)" : ""}; showing ${r.returned}.`;
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
      const r = await ops.nodeDetail(path, id);
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
        total: z.number(),
        byKind: z.record(z.string(), z.number()),
        insights: z.array(
          z.object({
            kind: z.string(),
            severity: z.string(),
            title: z.string(),
            detail: z.string(),
            nodeIds: z.array(z.string()),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ path, severity }) => {
      const r = await ops.listInsights(path, severity);
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
      },
      outputSchema: {
        config: z.string(),
        total: z.number(),
        errors: z.number(),
        warnings: z.number(),
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
    async ({ path, config }) => {
      const r = await ops.checkRules(path, config);
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
        blastRadius: z.array(z.object({ label: z.string(), delta: z.number() })),
      },
      annotations: READ_ONLY,
    },
    async ({ path, base, head }) => {
      const r = await ops.diffRevisions(path, base, head);
      const s = r.summary;
      const text =
        `${r.base} → ${r.head}: +${s.nodesAdded}/-${s.nodesRemoved} nodes (${s.nodesChanged} changed), ` +
        `+${s.edgesAdded}/-${s.edgesRemoved} edges, ${s.newCycles} new cycle(s).`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
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
