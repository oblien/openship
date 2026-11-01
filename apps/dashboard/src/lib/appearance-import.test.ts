import { expect, it, vi } from "vitest";
import { createTheme, defaultAppearance } from "@repo/core";
import { fetchAppearanceJson, importAppearance } from "./appearance-import";
it("merges a single theme by identity and round-trips an exported library", () => {
  const theme = createTheme("dim", "personal", "Personal");
  const first = importAppearance(JSON.stringify(theme), defaultAppearance());
  const next = importAppearance(JSON.stringify({ ...theme, name: "Updated" }), first);
  expect(next.themes).toHaveLength(1);
  expect(next.themes[0].name).toBe("Updated");
  expect(importAppearance(JSON.stringify(next), defaultAppearance())).toEqual(next);
});
it("does not send account credentials to a theme URL and rejects oversized responses", async () => {
  const fetcher = vi.fn(
    async (_url?: unknown, _options?: RequestInit) =>
      new Response(JSON.stringify(createTheme("dark", "personal", "Personal"))),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    await fetchAppearanceJson("https://themes.example.test/theme.json");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error" });
    await expect(fetchAppearanceJson("http://localhost/theme.json")).rejects.toThrow("HTTPS");
    fetcher.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(fetchAppearanceJson("https://themes.example.test/large.json")).rejects.toThrow(
      "1 MiB",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
