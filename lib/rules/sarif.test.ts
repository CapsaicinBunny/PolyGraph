import { describe, expect, test } from "bun:test";
import type { Violation } from "./engine";
import { toSarif } from "./sarif";

const violation = (over: Partial<Violation> = {}): Violation => ({
  ruleName: "Domain must not depend on UI",
  kind: "dependency",
  severity: "error",
  message: "src/domain/order.ts must not depend on src/ui/widget.ts",
  location: { filePath: "src/domain/order.ts", line: 12 },
  related: [{ filePath: "src/ui/widget.ts", line: 1, label: "widget.ts" }],
  ...over,
});

describe("toSarif", () => {
  test("produces a valid-shaped 2.1.0 log", () => {
    const log = toSarif([violation()]) as any;
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0].tool.driver.name).toBe("PolyGraph");
    expect(log.runs[0].results).toHaveLength(1);

    const r = log.runs[0].results[0];
    expect(r.ruleId).toBe("Domain must not depend on UI");
    expect(r.level).toBe("error");
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe("src/domain/order.ts");
    expect(r.locations[0].physicalLocation.region.startLine).toBe(12);
    expect(r.relatedLocations[0].physicalLocation.artifactLocation.uri).toBe("src/ui/widget.ts");
  });

  test("de-duplicates rules into the driver and indexes results", () => {
    const log = toSarif([
      violation(),
      violation({ message: "another", location: { filePath: "src/domain/x.ts", line: 3 } }),
      violation({ ruleName: "maxFanOut", kind: "fan-out", related: [] }),
    ]) as any;
    const rules = log.runs[0].tool.driver.rules;
    expect(rules.map((r: any) => r.id)).toEqual(["Domain must not depend on UI", "maxFanOut"]);
    expect(log.runs[0].results[2].ruleIndex).toBe(1);
  });

  test("warning severity maps to SARIF level warning; line floored to 1", () => {
    const log = toSarif([
      violation({ severity: "warning", location: { filePath: "a.ts", line: 0 } }),
    ]) as any;
    expect(log.runs[0].results[0].level).toBe("warning");
    expect(log.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(1);
  });

  test("backslash paths are normalized to forward slashes", () => {
    const log = toSarif([
      violation({ location: { filePath: "src\\domain\\o.ts", line: 1 } }),
    ]) as any;
    expect(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      "src/domain/o.ts",
    );
  });
});
