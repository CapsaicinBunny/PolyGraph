// Serialize architecture-rule violations to SARIF 2.1.0 — the format GitHub code
// scanning, Azure DevOps, and most CI dashboards ingest. Keeping this separate
// from the engine means the same violations render as text or SARIF unchanged.

import type { Violation } from "./engine";

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFO_URI = "https://github.com/CapsaicinBunny/PolyGraph";

interface SarifRegion {
  startLine: number;
}
interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: SarifRegion;
  };
}

function toLocation(filePath: string, line: number): SarifLocation {
  return {
    physicalLocation: {
      artifactLocation: { uri: filePath.replace(/\\/g, "/") },
      region: { startLine: Math.max(1, line) },
    },
  };
}

/** Build a SARIF log object (ready for JSON.stringify) from violations. */
export function toSarif(violations: Violation[], toolVersion = "0.1.0"): unknown {
  // One reportingDescriptor per distinct rule name, in first-seen order.
  const ruleIndex = new Map<string, number>();
  const rules: { id: string; name: string }[] = [];
  for (const v of violations) {
    if (!ruleIndex.has(v.ruleName)) {
      ruleIndex.set(v.ruleName, rules.length);
      rules.push({ id: v.ruleName, name: v.ruleName });
    }
  }

  const results = violations.map((v) => ({
    ruleId: v.ruleName,
    ruleIndex: ruleIndex.get(v.ruleName),
    level: v.severity, // "error" | "warning" are valid SARIF levels
    message: { text: v.message },
    locations: [toLocation(v.location.filePath, v.location.line)],
    relatedLocations: v.related.map((r, i) => ({
      ...toLocation(r.filePath, r.line),
      message: { text: r.label },
      id: i,
    })),
  }));

  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "PolyGraph",
            informationUri: INFO_URI,
            version: toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
}

/** Convenience: SARIF as a pretty-printed JSON string. */
export function toSarifString(violations: Violation[], toolVersion?: string): string {
  return `${JSON.stringify(toSarif(violations, toolVersion), null, 2)}\n`;
}
