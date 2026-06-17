import { afterEach, expect, test } from "bun:test";
import { apiBase } from "./api";
import { isTauri } from "./env";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("apiBase defaults to the dev sidecar port", () => {
  delete (globalThis as { window?: unknown }).window;
  expect(apiBase()).toBe("http://127.0.0.1:4319");
});

test("apiBase uses the injected app base when present", () => {
  (globalThis as { window?: unknown }).window = { __POLYGRAPH_API__: "http://127.0.0.1:55001" };
  expect(apiBase()).toBe("http://127.0.0.1:55001");
});

test("apiBase throws in Tauri before the base has been injected", () => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  expect(() => apiBase()).toThrow();
});

test("isTauri is false without the Tauri global", () => {
  (globalThis as { window?: unknown }).window = {};
  expect(isTauri()).toBe(false);
});

test("isTauri is true when the Tauri internals global exists", () => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  expect(isTauri()).toBe(true);
});
