import { beforeEach, describe, expect, test } from "bun:test";
import { telemetry } from "@/lib/telemetry";
import { installGlobalErrorHandlers } from "./global-errors";

// happy-dom registers window/document/Element globally via test-setup.ts.
describe("installGlobalErrorHandlers", () => {
  beforeEach(() => {
    // Idempotent (installs once); called here so it runs after window is guaranteed
    // present, regardless of test-file order. clearAll afterward drops session-start.
    installGlobalErrorHandlers();
    telemetry.clearAll();
  });

  test("captures uncaught errors as error-level events", () => {
    const ev = new Event("error");
    Object.assign(ev, {
      message: "boom",
      filename: "x.js",
      lineno: 3,
      colno: 5,
      error: new Error("boom"),
    });
    window.dispatchEvent(ev);

    const hit = telemetry.log.snapshot().find((e) => e.event === "uncaught-error");
    expect(hit?.category).toBe("app");
    expect(hit?.level).toBe("error");
    expect(hit?.data?.message).toBe("boom");
    expect(hit?.data?.source).toBe("x.js");
  });

  test("captures unhandled promise rejections", () => {
    const ev = new Event("unhandledrejection");
    Object.assign(ev, { reason: new Error("nope") });
    window.dispatchEvent(ev);

    const hit = telemetry.log.snapshot().find((e) => e.event === "unhandled-rejection");
    expect(hit?.level).toBe("error");
    expect(hit?.data?.message).toBe("nope");
  });

  test("distinguishes failed resource loads from script errors", () => {
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error")); // target is the element → resource-error
    document.body.removeChild(img);

    const hit = telemetry.log.snapshot().find((e) => e.event === "resource-error");
    expect(hit?.data?.tag).toBe("img");
  });
});
