// Telemetry scoped to the MCP server process. It records events to its ring buffer
// (read + controlled via the polygraph_logs tool) and mirrors them to STDERR.
//
// Why a dedicated instance instead of the shared `telemetry` singleton: the singleton
// mirrors to `globalThis.console`, and `console.info` is routed to STDOUT by Bun —
// which is the MCP JSON-RPC channel. Echoing events there would interleave non-JSON
// lines into the protocol stream and break the client. This instance pins the sink to
// STDERR so instrumentation can never corrupt the transport.

import { Telemetry } from "../lib/telemetry";

const toStderr = (...args: unknown[]): void => {
  console.error(...args);
};

export const telemetry = new Telemetry({
  console: { debug: toStderr, info: toStderr, warn: toStderr, error: toStderr },
});
