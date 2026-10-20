import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

for (const model of [
  undefined,
  "MiniMax-M3.1-Flash",
  "MiniMax-M3",
  "MiniMax-M2.7",
  "custom-model",
]) {
  for (const baseUrl of ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"]) {
    it(`loads ${model ?? "the Flash default"} for managed webmail through ${baseUrl}`, async () => {
      vi.resetModules();
      vi.stubEnv("MINIMAX_MODEL", model);
      vi.stubEnv("MINIMAX_BASE_URL", baseUrl);
      const { env } = await import("./env");
      expect(env.MINIMAX_MODEL).toBe(model ?? "MiniMax-M3.1-Flash");
      expect(env.MINIMAX_BASE_URL).toBe(baseUrl);
    });
  }
}
