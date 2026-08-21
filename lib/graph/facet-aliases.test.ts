import { describe, expect, test } from "bun:test";
import { canonicalFacetKey, FACET_KEY_ALIASES } from "./facet-aliases";

describe("facet aliases — the shared documented alias map (review bug d)", () => {
  test("the documented aliases map to their canonical catalog keys", () => {
    expect(FACET_KEY_ALIASES).toEqual({ environment: "env", lang: "language" });
  });

  test("canonicalFacetKey rewrites a documented alias", () => {
    expect(canonicalFacetKey("environment")).toBe("env");
    expect(canonicalFacetKey("lang")).toBe("language");
  });

  test("canonicalFacetKey is a no-op for a key that is already canonical", () => {
    for (const k of ["env", "language", "role", "category", "runtime", "kind", "folder"]) {
      expect(canonicalFacetKey(k)).toBe(k);
    }
  });

  test("canonicalFacetKey leaves an unknown/namespaced key unchanged", () => {
    expect(canonicalFacetKey("rust.visibility")).toBe("rust.visibility");
    expect(canonicalFacetKey("go.exported")).toBe("go.exported");
    expect(canonicalFacetKey("totally-unknown")).toBe("totally-unknown");
  });
});
