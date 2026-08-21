import { beforeEach, expect, test } from "bun:test";
import { logs } from "./operations";
// Importing the server module is safe: main() is guarded by `import.meta.main`,
// so nothing connects to a transport here.
import { instrument } from "./server";
import { telemetry } from "./telemetry";

beforeEach(() => {
  telemetry.setEnabled(true);
  telemetry.clearAll();
});

test("instrument returns the result and records an event + timing metric", async () => {
  const result = await instrument(
    "demo",
    () => Promise.resolve({ nodes: 7 }),
    (r) => ({ nodes: r.nodes }),
  );
  expect(result).toEqual({ nodes: 7 });

  const e = logs("tail").events[0];
  expect(e?.event).toBe("mcp.demo");
  expect(e?.data?.nodes).toBe(7);
  expect(typeof e?.data?.ms).toBe("number");

  expect(logs("metrics").metrics.histograms["mcp.demo.ms"]?.count).toBe(1);
});

test("instrument logs an error event at level error and rethrows", async () => {
  let message = "";
  try {
    await instrument(
      "boom",
      () => Promise.reject(new Error("kaboom")),
      () => ({}),
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toBe("kaboom"); // rethrown, not swallowed

  const e = logs("tail").events.at(-1);
  expect(e?.event).toBe("mcp.boom.error");
  expect(e?.level).toBe("error");
  expect(e?.data?.message).toContain("kaboom");
});

test("instrument records nothing while telemetry is disabled, but still runs the op", async () => {
  telemetry.setEnabled(false);
  expect(
    await instrument(
      "quiet",
      () => Promise.resolve(1),
      () => ({}),
    ),
  ).toBe(1);
  expect(logs("status").eventCount).toBe(0);
  telemetry.setEnabled(true);
});
