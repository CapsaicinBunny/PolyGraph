# PolyGraph MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
PolyGraph's code-graph analysis as **read-only** tools, so an AI agent can scan and
explore a codebase's structure — imports, calls, inheritance, cycles, rule
violations, and diffs between git revisions.

It runs locally over **stdio** and reuses PolyGraph's existing analysis library
(no network, no separate service). Analysis is cached per project path, so the
first `polygraph_scan` does the work and follow-up tools are fast.

## Tools

| Tool                 | What it does                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `polygraph_scan`     | Analyze a project directory → graph summary (file/node/edge counts, kind histograms, edge-confidence mix, packages). Run this first.                                                                                                                 |
| `polygraph_query`    | Run a [PolyGraph query](../lib/graph/query-language) (`kind:class`, `path:**/hooks/*.ts`, `incoming > 10`, `environment:client -> environment:server`, …) → matching nodes. Paginated via `limit`/`offset` (`hasMore` tells you when to keep going). |
| `polygraph_impact`   | "What breaks if I change this?" — the transitive dependent set of a node, grouped by area, relationship kind, and most-affected files.                                                                                                               |
| `polygraph_path`     | How one node reaches another: the shortest directed dependency path plus each connecting edge — or `connected: false` if there is none.                                                                                                              |
| `polygraph_node`     | A node's attributes + its dependencies (outgoing) and dependents (incoming), with edge kind, count, and confidence.                                                                                                                                  |
| `polygraph_insights` | Architectural findings: cycles, fan-in/out outliers, bottlenecks, orphans, client→server imports, undeclared deps, deep chains, instability, ambiguous/unresolved refs.                                                                              |
| `polygraph_check`    | Evaluate `.polygraph.yml` architecture rules → violations. `format: "sarif"` also returns a SARIF 2.1.0 log for CI upload.                                                                                                                           |
| `polygraph_diff`     | Structural diff of the graph between two git revisions (or a revision vs. the working tree).                                                                                                                                                         |
| `polygraph_read`     | Read the source of a scanned file (optional line range). Restricted to files under the scanned root — see Safety below.                                                                                                                              |
| `polygraph_logs`     | Read & control the live telemetry bus: `tail` events, `metrics` (per-tool timing), `status`, and `enable` / `disable` / `clear`.                                                                                                                     |

All tools return a text summary plus `structuredContent`. All are `readOnlyHint`
except `polygraph_logs`, whose `enable` / `disable` / `clear` actions mutate the
telemetry buffer (`clear` is irreversible, hence `destructiveHint`).

Two behaviors worth knowing, because both would otherwise produce a confident
wrong answer:

- **Only `polygraph_scan` re-analyzes.** Every other tool reuses the cached scan
  for that path, so after editing files you must re-run `polygraph_scan` or you
  get pre-edit answers. Each result echoes `scannedAt` (epoch ms) so the staleness
  is at least visible.
- **An unrecognized query field is not an error** in the query language — it
  degrades to a text match. `polygraph_query` therefore reports `unknownFields`,
  because otherwise a typo'd field is indistinguishable from a valid query that
  genuinely matched nothing.

Capped lists always ship their true total alongside (`packagesTotal`,
`nodeIdTotal`, `filesAffected`, `blastRadiusTotal`, `matchCount`), so a truncated
list is never mistaken for the whole answer.

## Safety: the read tool

`polygraph_read` can only read files PolyGraph **already analyzed under the scanned
root** — two independent gates enforce it: the file must be a file node in the
scanned graph (so only real source that passed the scanner's extension/ignore
filters — excludes `node_modules`, build output, and non-source files like a bare
`.env`; note source files such as `.json`/`.sql` are in scope, so this bounds reads
to the analyzed source set rather than being a secrets firewall), and its
canonicalized (`realpath`) path must stay inside the canonical root (defeating `../`
and symlink escapes). Since the
server is LLM-driven, this scoping is deliberate: a repository it analyzes cannot
steer it into reading arbitrary files on the machine.

## Run it

```sh
bun run mcp          # = bun run mcp/server.ts
```

The server speaks MCP on **stdout**, so every diagnostic goes to **stderr**: a
`[polygraph-mcp] ready on stdio` line at startup, then a `[scan]` line and a
telemetry line per tool call (silence those with
`polygraph_logs {"action":"disable"}`), plus `[polygraph-mcp] fatal:` on a crash.
Nothing but JSON-RPC is ever written to stdout.

## Wire it into a client

**Claude Code, in this repo — nothing to do.** The repo ships a project-scoped
[`.mcp.json`](../.mcp.json), so opening PolyGraph in Claude Code discovers the
server automatically (you'll be asked to approve it once). It uses a relative
path, so it works on any clone with no per-machine setup.

**Claude Code, to analyze _other_ projects** — register it globally once:

```sh
claude mcp add --scope user polygraph -- bun run /absolute/path/to/PolyGraph/mcp/server.ts
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

## Widget (MCP Apps)

[`widgets/polygraph-scan-widget.html`](widgets/polygraph-scan-widget.html) is an
[MCP Apps](https://modelcontextprotocol.io) widget that renders a `polygraph_scan`
result: KPI tiles, a stacked **edge-confidence** bar (exact / inferred /
ambiguous), and bar charts for node and relationship kinds. Problems (parse
warnings, unresolved refs, skipped files) appear only when there are some — and a
"scan health unknown" pill when those fields are absent, so a partial payload
can't masquerade as a clean scan. A **Rescan** button re-invokes `polygraph_scan`
through `callServerTool`, using the `root` the previous result reported.

The server registers it as the resource **`ui://polygraph/scan-widget`**, so a
client can list and fetch it. That is as far as the wiring goes: **no host will
render it automatically yet.** Auto-rendering requires binding the resource to the
tool through `_meta`, under a key the MCP Apps host defines; that key is not
guessed here. Until it's added, the widget is fetchable and self-testable, not
automatic.

No build step and no chart library (plain CSS bars). It does load three modules
from CDNs at runtime — the Fluent UI web components, `@fluentui/tokens`, and the
MCP `ext-apps` client — so it needs network access in the host and will not render
offline or under a strict CSP. It themes itself from the host via Fluent tokens,
renders all tool data with `textContent`, and coerces field types defensively,
since JSON fields can arrive as strings or nulls.

## Develop / inspect

```sh
bun test mcp            # operations, cache, instrumentation + a client round-trip
npx @modelcontextprotocol/inspector bun run mcp/server.ts   # interactive tool inspector
```

Architecture: `operations.ts` holds the ten analysis functions (unit-tested
directly); `server.ts` registers each as an MCP tool and wraps it in `instrument`
(both unit-tested); `cache.ts` memoizes scans per project path; `telemetry.ts` is
the stderr-pinned telemetry bus the `polygraph_logs` tool reads.

`mcp/server.test.ts` drives the server through a real MCP `Client` over
`InMemoryTransport`. That layer is not optional: the SDK **client** validates
`structuredContent` against the published `outputSchema`, so a field the schema
omits is a hard client-side rejection even though the server's own parse strips it
and looks healthy. Testing `operations.ts` alone cannot see that class of bug —
it shipped once already (`GraphNode.facets`).

Beyond `bun run mcp`, the server is also available as the `polygraph-mcp` bin, and
`bun run build:mcp` compiles a standalone binary (with the widget embedded) for
hosts without Bun.
