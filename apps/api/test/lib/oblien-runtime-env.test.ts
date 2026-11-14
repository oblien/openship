import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  [undefined, "https://vm.oblien.com"],
  ["https://runtime.staging.example", "https://runtime.staging.example"],
])("configures the native VM credential endpoint with override %s", async (override, expected) => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("BILLING_ENABLED", "false");
  vi.stubEnv("OBLIEN_RUNTIME_URL", override);
  const { env } = await import("@repo/platform/engine/config/env");
  expect(env.OBLIEN_RUNTIME_URL).toBe(expected);
});
