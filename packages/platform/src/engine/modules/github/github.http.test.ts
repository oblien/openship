import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch, GitHubApiError } from "./github.http";
vi.mock("../../lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
describe("GitHub mutation receipts and signed downloads", () => {
  it.each([201, 202, 204, 205])(
    "accepts an empty HTTP %i without retrying a successful mutation",
    async (status) => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(
        ghFetch("private-token", {
          url: "https://api.github.com/repos/owner/repo/actions/runs/1/rerun",
          method: "POST",
        }),
      ).resolves.toEqual({ success: true });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it("returns the signed redirect without sending repository authorization to storage", async () => {
    const url = "https://example.blob.core.windows.net/logs/signed";
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: url } }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      ghFetch("private-token", {
        url: "https://api.github.com/repos/owner/repo/actions/jobs/1/logs",
        response: "redirect",
      }),
    ).resolves.toEqual({ url });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toContain("api.github.com");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });
  it("preserves authorization failures for the caller's retry policy", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ message: "Forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      ghFetch("private-token", { url: "https://api.github.com/repos/owner/repo/actions/runners" }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
