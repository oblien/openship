import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  findByInstallationId: vi.fn(),
  upsert: vi.fn(),
  removeByInstallationId: vi.fn(),
  suspendByInstallationId: vi.fn(),
  deleteGrants: vi.fn(),
  invalidateUser: vi.fn(),
  invalidateOrg: vi.fn(),
  findByOrgAndOwner: vi.fn(),
  listSourcesForWebhook: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    gitInstallation: {
      findByInstallationIdForProvider: h.findByInstallationId,
      upsert: h.upsert,
      removeByInstallationIdForProvider: h.removeByInstallationId,
      suspendByInstallationIdForProvider: h.suspendByInstallationId,
      findByOrgAndOwner: h.findByOrgAndOwner,
    },
    resourceGrant: { deleteGitHubGrantsForOwner: h.deleteGrants },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  getGitHubAuthMode: () => "app",
  invalidateUserGitHubCache: h.invalidateUser,
  invalidateOrgGitHubCache: h.invalidateOrg,
}));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({
  listGitHubSourcesForWebhook: h.listSourcesForWebhook,
}));

import { handleInstallation } from "./webhook-installation";

const payload = (action: "created" | "deleted" | "suspend" | "unsuspend") =>
  ({
    action,
    installation: {
      id: 42,
      account: { login: "Acme", id: 700, avatar_url: "", type: "Organization" },
      app_id: 9,
      target_type: "Organization",
      permissions: {},
      events: [],
    },
    sender: { id: 88, login: "installer" },
  }) as any;

const bindings = [
  { userId: "u1", organizationId: "o1", owner: "acme", sourceId: null },
  { userId: "u1", organizationId: "o2", owner: "acme", sourceId: null },
];

describe("GitHub installation webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByInstallationId.mockResolvedValue(bindings);
    h.upsert.mockResolvedValue({});
    h.removeByInstallationId.mockResolvedValue(undefined);
    h.suspendByInstallationId.mockResolvedValue(undefined);
    h.findByOrgAndOwner.mockResolvedValue(undefined);
    h.deleteGrants.mockResolvedValue(0);
    h.listSourcesForWebhook.mockResolvedValue([]);
  });

  it("does not guess a workspace when created arrives before the setup claim", async () => {
    h.findByInstallationId.mockResolvedValue([]);

    const result = await handleInstallation(payload("created"));

    expect(result.success).toBe(true);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refreshes only already-claimed workspace bindings", async () => {
    await handleInstallation(payload("created"));

    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "o1" }));
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "o2" }));
  });

  it("keeps bindings and grants during reversible suspension", async () => {
    await handleInstallation(payload("suspend"));

    expect(h.removeByInstallationId).not.toHaveBeenCalled();
    expect(h.suspendByInstallationId).toHaveBeenCalledWith(42, null);
    expect(h.deleteGrants).not.toHaveBeenCalled();
    expect(h.invalidateOrg).toHaveBeenCalledTimes(2);
  });

  it("removes every workspace binding and grant on uninstall", async () => {
    await handleInstallation(payload("deleted"));

    expect(h.removeByInstallationId).toHaveBeenCalledWith(42, null);
    expect(h.deleteGrants).toHaveBeenCalledWith("o1", "acme");
    expect(h.deleteGrants).toHaveBeenCalledWith("o2", "acme");
  });

  it("refreshes an existing binding for the custom App that signed the delivery", async () => {
    h.listSourcesForWebhook.mockResolvedValue([{ id: "src_custom" }]);
    h.findByInstallationId.mockResolvedValue([
      { userId: "u1", organizationId: "o1", owner: "acme", sourceId: "src_custom" },
      { userId: "u2", organizationId: "o2", owner: "acme", sourceId: "src_other" },
    ]);

    await handleInstallation(payload("created"));

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o1",
        sourceId: "src_custom",
        installationId: 42,
        owner: "acme",
      }),
    );
  });

  it("removes only the custom source bindings in scope for an uninstall delivery", async () => {
    h.listSourcesForWebhook.mockResolvedValue([{ id: "src_custom" }]);
    h.findByInstallationId.mockResolvedValue([
      { userId: "u1", organizationId: "o1", owner: "acme", sourceId: "src_custom" },
      { userId: "u2", organizationId: "o2", owner: "acme", sourceId: "src_other" },
    ]);

    await handleInstallation(payload("deleted"));

    expect(h.removeByInstallationId).toHaveBeenCalledTimes(1);
    expect(h.removeByInstallationId).toHaveBeenCalledWith(42, "src_custom");
    expect(h.deleteGrants).toHaveBeenCalledTimes(1);
    expect(h.deleteGrants).toHaveBeenCalledWith("o1", "acme");
    expect(h.invalidateOrg).toHaveBeenCalledWith("o1");
    expect(h.invalidateOrg).not.toHaveBeenCalledWith("o2");
  });
});
