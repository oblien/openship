import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";
const h = vi.hoisted(() => ({ request: vi.fn(), token: vi.fn() }));
vi.mock("./github.auth", () => ({ githubFetch: h.request, getInstallationToken: h.token }));
vi.mock("../../lib/cache-store/index", () => ({ cacheStore: vi.fn() }));
import { checkFailureSummary, syncGitHubCheck, type GitHubCheckUpdate } from "./check-runs";
import { GitHubApiError } from "./github.http";
const ctx = { userId: "owner", organizationId: "org" } as ExecutionContext;
const update: GitHubCheckUpdate = {
  name: "Openship / app", externalId: "deployment:attempt:one", headSha: "a".repeat(40),
  status: "completed", conclusion: "failure", output: { title: "Deployment failed", summary: "Build failed" },
};
beforeEach(() => { vi.resetAllMocks(); h.token.mockResolvedValue("app-token"); });

describe("shared GitHub Check transport", () => {
  it("never selects a personal or CLI credential instead of the scoped App", async () => {
    h.request.mockImplementation(async ({ method }) => method === "GET" ? { check_runs: [] } : { id: 42 });
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update)).toEqual({ id: "42", error: null });
    expect(h.request.mock.calls.every(([request]) => request.ctx === ctx && request.credential[0] === "app-installation")).toBe(true);
  });
  it("rechecks a delivery lease after searching and before creating", async () => {
    h.request.mockResolvedValue({ check_runs: [] });
    const canSend = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update, { canSend })).toMatchObject({ error: "GitHub Check delivery lease ended" });
    expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  });
  it("distinguishes missing App permissions from a temporary GitHub rate limit", async () => {
    h.request.mockRejectedValueOnce(new GitHubApiError(403, "Resource not accessible by integration", new Headers()));
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update)).toMatchObject({ unavailable: true });
    h.request.mockRejectedValueOnce(new GitHubApiError(403, "API rate limit exceeded", new Headers({ "x-ratelimit-remaining": "0" })));
    expect((await syncGitHubCheck(ctx, "acme", "app", null, update)).unavailable).not.toBe(true);
  });
  it("can close a previously accepted Check after opt-out without creating another", async () => {
    h.request.mockImplementation(async ({ method }) => method === "GET"
      ? { check_runs: [{ id: 42, external_id: update.externalId }] } : {});
    expect(await syncGitHubCheck(ctx, "acme", "app", null, { ...update, conclusion: "neutral" }, { createIfMissing: false })).toEqual({ id: "42", error: null });
    expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PATCH"]);
    h.request.mockClear().mockResolvedValue({ check_runs: [] });
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update, { createIfMissing: false })).toMatchObject({ skipped: true });
    expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  });
  it("recovers an uncertain POST by the stable attempt identity", async () => {
    const remote: Array<{ id: number; external_id: string }> = [];
    h.request.mockImplementation(async ({ method, params }) => {
      if (method === "GET") return { check_runs: remote };
      if (method === "POST") { remote.push({ id: 123, external_id: params.external_id }); throw new Error("Response lost"); }
      return { id: 123 };
    });
    expect((await syncGitHubCheck(ctx, "acme", "app", null, update)).error).toBe("Response lost");
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update)).toEqual({ id: "123", error: null });
    expect(h.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("does not store an invalid identity when GitHub returns an incomplete creation receipt", async () => {
    h.request.mockImplementation(async ({ method }) => method === "GET" ? { check_runs: [] } : {});
    expect(await syncGitHubCheck(ctx, "acme", "app", null, update)).toMatchObject({ id: null, error: "GitHub did not confirm the created Check" });
  });
  it("redacts env values, tokens and authenticated URLs while retaining a useful error", () => {
    expect(checkFailureSummary("Build failed for secret-value at https://user:secret@host.test/log?token=hidden", ["secret-value"]))
      .toBe("Build failed for [REDACTED] at https://host.test/log");
    expect(checkFailureSummary("Bearer some-token\n" + "x".repeat(20_000))).not.toContain("some-token");
    expect(checkFailureSummary("x".repeat(20_000)).length).toBeLessThanOrEqual(4001);
    const longSecret = "unrecognizable-credential-".repeat(1000);
    expect(checkFailureSummary(`Build failed: ${longSecret}`, [longSecret])).toBe("Build failed: [REDACTED]");
  });
});
