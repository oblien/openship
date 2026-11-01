import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  request: vi.fn(),
  bridge: vi.fn(),
  scope: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: h.client }));
vi.mock("@repo/platform/engine/lib/cloud/scope", () => ({ assertCloudTenantScope: h.scope }));
vi.mock("@repo/platform/engine/modules/github/github-repository-authorization", () => ({
  REPOSITORY_OAUTH_STATE_PREFIX: "ghrepo_",
}));
import { cloudGitHubConnection } from "@repo/platform/engine/modules/github/github-cloud-connection";
const ctx = { organizationId: "local-workspace", userId: "local-owner" } as any;
beforeEach(() => {
  vi.resetAllMocks();
  h.scope.mockResolvedValue(undefined);
  h.client.mockReturnValue({ request: h.request, github: { oauthHandoff: h.bridge } });
});
describe("hosted GitHub connection delegate", () => {
  it.each([401, 403, 409, 502])("preserves actionable Cloud status %s", async (status) => {
    h.request.mockResolvedValue(
      Response.json({ error: "Try reconnecting", code: "GITHUB_ATTEMPT_EXPIRED" }, { status }),
    );
    await expect(
      cloudGitHubConnection(ctx, "claimInstallation", {
        state: "ghrepo_state",
        installationId: 42,
      }),
    ).rejects.toMatchObject({ statusCode: status, code: "GITHUB_ATTEMPT_EXPIRED" });
  });
  it.each([
    null,
    {},
    { connected: false },
    { connected: false, flow: "redirect" },
    {
      connected: false,
      flow: "redirect",
      state: "unbound",
      completion: "attempt",
      url: "not-a-url",
    },
    { data: { status: "complete" } },
  ])("rejects a malformed successful connection response: %j", async (body) => {
    h.request.mockResolvedValue(Response.json(body));
    await expect(cloudGitHubConnection(ctx, "connect", {})).rejects.toMatchObject({
      code: "CLOUD_GITHUB_INVALID_RESPONSE",
    });
  });
  it("refuses a missing or replaced Cloud connection without local fallback", async () => {
    h.request.mockResolvedValue(null);
    await expect(cloudGitHubConnection(ctx, "connect", {})).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(h.client).toHaveBeenCalledWith({ organizationId: "local-workspace" });
  });
  it("checks the linked workspace before making any Cloud call", async () => {
    h.scope.mockRejectedValue(new Error("No linked workspace"));
    await expect(cloudGitHubConnection(ctx, "connect", {})).rejects.toThrow("No linked workspace");
    expect(h.request).not.toHaveBeenCalled();
  });
  it("keeps the attempt waiting when its OAuth bridge cannot be issued", async () => {
    h.request.mockResolvedValue(
      Response.json({
        connected: false,
        flow: "redirect",
        completion: "attempt",
        step: "install",
        state: "ghrepo_state",
        url: "https://api.openship.test/api/github/connect/redirect?install_state=ghrepo_state",
      }),
    );
    h.bridge.mockResolvedValue(null);
    await expect(cloudGitHubConnection(ctx, "connect", {})).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(h.bridge).toHaveBeenCalledWith("ghrepo_state");
  });
});
