import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghFetch, GitHubApiError, probeAnonymousRepoVisibility } from "./github.http";
const { observeCaughtError } = vi.hoisted(() => ({ observeCaughtError: vi.fn() }));
vi.mock("@repo/core/diagnostics", async (original) => ({
  ...await original<typeof import("@repo/core/diagnostics")>(),
  reportCaughtError: observeCaughtError,
}));
beforeEach(() => observeCaughtError.mockClear());
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


it("keeps malformed anonymous visibility responses unknown without reporting response payloads", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-upstream-payload", { status: 200 })));
  await expect(probeAnonymousRepoVisibility("acme", "repo")).resolves.toBe("unknown");
  expect(observeCaughtError).toHaveBeenCalledOnce();
  expect(observeCaughtError).toHaveBeenCalledWith(
    expect.objectContaining({ name: "SyntaxError", message: "GitHub anonymous repository visibility returned invalid JSON" }),
    "platform/engine/modules/github/github.http",
  );
  expect(observeCaughtError.mock.calls[0]![0].message).not.toContain("private-upstream-payload");
});
