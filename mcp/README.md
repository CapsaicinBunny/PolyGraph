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
| `polygraph_read`     | Read the source of a scanned file (optional line range). Restricted to files under the scanned root — see Safety below.                                                     |
| `polygraph_logs`     | Read & control the live telemetry bus: `tail` events, `metrics` (per-tool timing), `status`, and `enable` / `disable` / `clear`.                                            |

All tools return a text summary plus `structuredContent`. All are `readOnlyHint`
except `polygraph_logs`, whose `enable` / `disable` / `clear` actions mutate the
telemetry buffer.

## Safety: the read tool

`polygraph_read` can only read files PolyGraph **already analyzed under the scanned
root** — two independent gates enforce it: the file must be a file node in the
scanned graph (so only real source files that passed the scanner's filters — never
`node_modules`, `.env`, or secrets), and its canonicalized (`realpath`) path must
stay inside the canonical root (defeating `../` and symlink escapes). Since the
server is LLM-driven, this scoping is deliberate: a repository it analyzes cannot
steer it into reading arbitrary files on the machine.

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
