import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findState: vi.fn(),
  claim: vi.fn(),
  audit: vi.fn(),
  ghFetch: vi.fn(),
  appFetch: vi.fn(),
  consume: vi.fn(),
  invalidateUser: vi.fn(),
  invalidateOrg: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    githubInstallState: { find: h.findState },
    gitInstallation: { claimWithState: h.claim },
    auditEvent: { create: h.audit },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: { CLOUD_MODE: false },
  localGitHubAppConfiguration: { configured: true, intended: true, missing: [] },
}));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({ ghFetch: h.ghFetch }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  appFetch: h.appFetch,
  consumeInstallState: h.consume,
  getUserToken: vi.fn(async () => "github-user-token"),
  invalidateOrgGitHubCache: h.invalidateOrg,
  invalidateUserGitHubCache: h.invalidateUser,
  resolveGitHubAuthMode: vi.fn(async () => "app"),
}));

import { claimLocalGitHubInstallation } from "@repo/platform/engine/modules/github/github.installation-claim";

const ctx = { userId: "user_1", organizationId: "org_1" } as any;
const installation = {
  id: 42,
  account: { login: "Acme", id: 700, avatar_url: "", type: "Organization" },
  app_id: 9,
  target_type: "Organization",
  permissions: {},
  events: [],
};

describe("claimLocalGitHubInstallation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findState.mockResolvedValue({
      state: "nonce",
      userId: "user_1",
      organizationId: "org_1",
      sourceId: null,
      flow: "install",
    });
    h.ghFetch.mockResolvedValue({ total_count: 1, installations: [installation] });
    h.appFetch.mockResolvedValue(installation);
    h.consume.mockResolvedValue({ userId: "user_1", organizationId: "org_1" });
    h.claim.mockResolvedValue({ id: "row" });
    h.audit.mockResolvedValue({});
  });

  it("binds a GitHub-verified installation to the originating workspace", async () => {
    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: "42",
      setupAction: "install",
    });

    expect(result).toEqual({
      kind: "ok",
      installation: { id: 42, login: "Acme", type: "Organization" },
    });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.claim).toHaveBeenCalledWith(
      "nonce",
      expect.objectContaining({
        userId: "user_1",
        organizationId: "org_1",
        installationId: 42,
        owner: "acme",
      }),
    );
  });

  it("rejects a state opened from another active workspace before calling GitHub", async () => {
    h.findState.mockResolvedValue({
      state: "nonce",
      userId: "user_1",
      organizationId: "org_other",
      sourceId: null,
      flow: "install",
    });

    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: 42,
    });

    expect(result.kind).toBe("forbidden");
    expect(h.ghFetch).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("rejects a spoofed installation_id the installing user cannot see", async () => {
    h.ghFetch.mockResolvedValue({ total_count: 0, installations: [] });

    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: 42,
    });

    expect(result.kind).toBe("forbidden");
    expect(h.appFetch).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("atomically rejects a replay that loses the one-shot consume race", async () => {
    h.claim.mockResolvedValue(null);

    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: 42,
    });

    expect(result.kind).toBe("forbidden");
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("does not misreport a committed claim when cache eviction is unavailable", async () => {
    h.invalidateOrg.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: 42,
    });

    expect(result.kind).toBe("ok");
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it("records an approval request without trusting or persisting an installation", async () => {
    const result = await claimLocalGitHubInstallation(ctx, {
      state: "nonce",
      installationId: 42,
      setupAction: "request",
    });

    expect(result).toEqual({ kind: "pending-approval" });
    expect(h.ghFetch).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });
});
