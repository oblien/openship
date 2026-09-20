import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  statePurge: vi.fn(),
  stateCreate: vi.fn(),
  stateFind: vi.fn(),
  stateConsume: vi.fn(),
  stateRemove: vi.fn(),
  memberFind: vi.fn(),
  claim: vi.fn(),
  audit: vi.fn(),
  verify: vi.fn(),
  invalidateUser: vi.fn(),
  invalidateOrg: vi.fn(),
  getInstallUrl: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    githubInstallState: {
      purgeExpired: h.statePurge,
      create: h.stateCreate,
      find: h.stateFind,
      consume: h.stateConsume,
      remove: h.stateRemove,
    },
    member: { find: h.memberFind },
    gitInstallation: {
      claimWithState: h.claim,
      findByOrgAndOwner: vi.fn(),
    },
    auditEvent: { create: h.audit },
  },
}));
vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: { api: {} },
  COOKIE_PREFIX: "openship",
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  cloudRuntimeTarget: { api: "https://api.openship.io" },
}));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({
  resolveOrgOwner: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  getInstallUrl: h.getInstallUrl,
  invalidateUserGitHubCache: h.invalidateUser,
  invalidateOrgGitHubCache: h.invalidateOrg,
}));
vi.mock("@repo/platform/engine/modules/github/github.installation-verification", () => ({
  verifyGitHubInstallationForUser: h.verify,
}));

import {
  attributeGithubInstall,
  buildOrgScopedInstallUrl,
} from "@repo/platform/engine/modules/cloud/cloud-github.service";

const installation = {
  id: 42,
  account: { login: "Acme", id: 700, avatar_url: "", type: "Organization" },
  app_id: 9,
  target_type: "Organization",
  permissions: {},
  events: [],
};
const callbackInput = {
  installationIdRaw: "42",
  setupAction: "install",
  state: "nonce",
  clientIp: "203.0.113.7",
  userAgent: "test-agent",
};

describe("cloud GitHub App installation attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.statePurge.mockResolvedValue(0);
    h.stateCreate.mockResolvedValue(undefined);
    h.stateFind.mockResolvedValue({
      state: "nonce",
      userId: "user_1",
      organizationId: "org_1",
    });
    h.stateConsume.mockResolvedValue({
      state: "nonce",
      userId: "user_1",
      organizationId: "org_1",
    });
    h.stateRemove.mockResolvedValue(undefined);
    h.memberFind.mockResolvedValue({ id: "member_1", role: "member" });
    h.verify.mockResolvedValue({ kind: "ok", installation });
    h.claim.mockResolvedValue({ id: "installation_row" });
    h.audit.mockResolvedValue({});
    h.invalidateUser.mockResolvedValue(undefined);
    h.invalidateOrg.mockResolvedValue(undefined);
    h.getInstallUrl.mockReturnValue(
      "https://github.com/apps/openship-io/installations/new",
    );
  });

  it("persists install state for the actual caller and active workspace", async () => {
    const result = await buildOrgScopedInstallUrl("member_1", "org_1");

    expect(result.state).toHaveLength(32);
    expect(result.url).toBe(
      `https://github.com/apps/openship-io/installations/new?state=${result.state}`,
    );
    expect(h.stateCreate).toHaveBeenCalledWith(expect.objectContaining({
      state: result.state,
      userId: "member_1",
      organizationId: "org_1",
    }));
  });

  it("rejects invalid installation ids before reading or burning state", async () => {
    const result = await attributeGithubInstall({
      ...callbackInput,
      installationIdRaw: "42.5",
    });

    expect(result.kind).toBe("invalid-installation-id");
    expect(h.stateFind).not.toHaveBeenCalled();
    expect(h.stateConsume).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("rejects spoofed cross-tenant installation ids without consuming state", async () => {
    h.verify.mockResolvedValue({
      kind: "forbidden",
      reason: "not-user-accessible",
      message: "GitHub did not confirm this installation.",
    });

    const result = await attributeGithubInstall(callbackInput);

    expect(result).toEqual({
      kind: "forbidden",
      message: "GitHub did not confirm this installation.",
    });
    expect(h.verify).toHaveBeenCalledWith("user_1", 42);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.stateConsume).not.toHaveBeenCalled();
  });

  it("revokes a live state when the initiating user left the workspace", async () => {
    h.memberFind.mockResolvedValue(null);

    await expect(attributeGithubInstall(callbackInput)).resolves.toEqual({
      kind: "forbidden",
      message: "You no longer have access to the Openship workspace that started this install.",
    });
    expect(h.stateRemove).toHaveBeenCalledWith("nonce");
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("atomically claims the verified installation for exactly the bound workspace", async () => {
    const result = await attributeGithubInstall(callbackInput);

    expect(result).toMatchObject({
      kind: "ok",
      organizationId: "org_1",
      installation: { id: 42 },
    });
    expect(h.claim).toHaveBeenCalledWith("nonce", expect.objectContaining({
      userId: "user_1",
      organizationId: "org_1",
      installationId: 42,
      owner: "acme",
      providerOwnerId: "700",
    }));
    expect(h.stateConsume).not.toHaveBeenCalled();
  });

  it("allows only one winner when callbacks race or replay", async () => {
    h.claim.mockResolvedValue(null);

    await expect(attributeGithubInstall(callbackInput)).resolves.toEqual({
      kind: "state-expired",
    });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("keeps the state retryable when the atomic database claim fails", async () => {
    h.claim.mockRejectedValue(new Error("database unavailable"));

    await expect(attributeGithubInstall(callbackInput)).resolves.toEqual({
      kind: "failed",
      installationId: 42,
      error: "database unavailable",
    });
    expect(h.stateConsume).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("consumes approval-request state without creating an installation", async () => {
    const result = await attributeGithubInstall({
      ...callbackInput,
      setupAction: "request",
    });

    expect(result).toEqual({ kind: "pending-approval" });
    expect(h.stateConsume).toHaveBeenCalledWith("nonce");
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("does not turn a committed claim into failure when cache eviction fails", async () => {
    h.invalidateOrg.mockRejectedValue(new Error("redis unavailable"));

    await expect(attributeGithubInstall(callbackInput)).resolves.toMatchObject({ kind: "ok" });
    expect(h.claim).toHaveBeenCalledTimes(1);
  });
});
