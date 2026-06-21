# PolyGraph MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
PolyGraph's code-graph analysis as **read-only** tools, so an AI agent can scan and
explore a codebase's structure — imports, calls, inheritance, cycles, rule
violations, and diffs between git revisions.

It runs locally over **stdio** and reuses PolyGraph's existing analysis library
(no network, no separate service). Analysis is cached per project path, so the
first `polygraph_scan` does the work and follow-up tools are fast.

## Tools

| Tool                 | What it does                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `polygraph_scan`     | Analyze a project directory → graph summary (file/node/edge counts, kind histograms, edge-confidence mix, packages). Run this first.                                        |
| `polygraph_query`    | Run a [PolyGraph query](../lib/graph/query-language) (`kind:class`, `path:**/hooks/*.ts`, `incoming > 10`, `environment:client -> environment:server`, …) → matching nodes. |
| `polygraph_node`     | A node's attributes + its dependencies (outgoing) and dependents (incoming), with edge kind, count, and confidence.                                                         |
| `polygraph_insights` | Architectural findings: cycles, fan-in/out outliers, bottlenecks, orphans, client→server imports, undeclared deps, deep chains, instability, ambiguous/unresolved refs.     |
| `polygraph_check`    | Evaluate `.polygraph.yml` architecture rules → violations.                                                                                                                  |
| `polygraph_diff`     | Structural diff of the graph between two git revisions (or a revision vs. the working tree).                                                                                |

All tools are annotated `readOnlyHint` and return both a text summary and
`structuredContent`.

## Run it

```sh
bun run mcp          # = bun run mcp/server.ts
```

The server speaks MCP on stdio; it prints only `[polygraph-mcp] ready on stdio`
to **stderr** (stdout is the protocol channel).

## Wire it into a client

**Claude Code:**

```sh
claude mcp add polygraph -- bun run /absolute/path/to/PolyGraph/mcp/server.ts
```

**Claude Desktop** (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "polygraph": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/PolyGraph/mcp/server.ts"]
    }
  }
}
```

Then ask things like _"Scan /path/to/repo and list its dependency cycles"_ or
_"In /path/to/repo, which files have more than 10 dependents?"_.

## Develop / inspect

```sh
bun test mcp                                   # unit tests (operations)
npx @modelcontextprotocol/inspector bun run mcp/server.ts   # interactive tool inspector
```

Architecture: `operations.ts` holds the six analysis functions as plain async
calls (unit-tested directly); `server.ts` is a thin layer that registers each as
an MCP tool; `cache.ts` memoizes scans per project path.
