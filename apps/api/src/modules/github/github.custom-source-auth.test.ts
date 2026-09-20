import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cloudConnected: vi.fn(),
  cloudInstallations: vi.fn(),
  cloudInstallationToken: vi.fn(),
  findByOrgAndOwner: vi.fn(),
  findByOrgOwnerAndInstallationId: vi.fn(),
  hasActiveSource: vi.fn(),
  resolveSourceCredentials: vi.fn(),
  appFetch: vi.fn(),
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    CLOUD_MODE: false,
    GITHUB_AUTH_MODE: "auto",
    GITHUB_APP_ID: undefined,
    GITHUB_APP_SLUG: "openship-io",
    GITHUB_PRIVATE_KEY: undefined,
    GITHUB_PRIVATE_KEY_BASE64: undefined,
  },
  localGitHubAppConfiguration: { configured: false, intended: false, missing: [] },
}));

vi.mock("@repo/db", () => ({
  repos: {
    gitInstallation: {
      findByOrgAndOwner: h.findByOrgAndOwner,
      findByOrgOwnerAndInstallationId: h.findByOrgOwnerAndInstallationId,
    },
  },
  db: {},
  schema: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getAccessToken: vi.fn() } } }));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: vi.fn(async () => ({
    get: h.cacheGet,
    set: h.cacheSet,
    invalidateByPrefix: vi.fn(),
  })),
}));
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn() }));
vi.mock("@repo/platform/engine/lib/cloud/session", () => ({
  isCloudConnectedForOrg: h.cloudConnected,
  isCloudConnected: h.cloudConnected,
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({
  cloudClient: vi.fn(() => ({
    github: {
      installations: h.cloudInstallations,
      installationToken: h.cloudInstallationToken,
    },
  })),
}));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({
  ghFetch: vi.fn(),
  ghFetchPublic: vi.fn(),
  ghFetchSoft: vi.fn(),
}));
vi.mock("@repo/platform/engine/modules/github/github.app-client", () => ({
  generateGitHubAppJwt: vi.fn(),
  githubAppFetch: h.appFetch,
}));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({
  createSourceInstallUrl: vi.fn(),
  hasActiveGitHubSource: h.hasActiveSource,
  resolveGitHubApiBaseUrl: vi.fn(),
  resolveGitHubSourceCredentialsForInstallation: h.resolveSourceCredentials,
}));

import { getInstallationId, getInstallationToken, resolveGitHubAuthMode } from "@repo/platform/engine/modules/github/github.auth";

const ctx = {
  userId: "user_1",
  organizationId: "org_1",
  role: "owner",
} as any;

const legacyInstallation = {
  id: "legacy",
  organizationId: "org_1",
  userId: "user_1",
  provider: "github",
  owner: "legacy-owner",
  installationId: 77,
  sourceId: null,
};

const customInstallation = {
  ...legacyInstallation,
  id: "custom",
  owner: "custom-owner",
  installationId: 88,
  sourceId: "src_custom",
};

describe("mixed custom and legacy GitHub source resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cacheGet.mockResolvedValue(null);
    h.cacheSet.mockResolvedValue(undefined);
    h.hasActiveSource.mockResolvedValue(true);
    h.cloudConnected.mockResolvedValue(false);
    h.findByOrgOwnerAndInstallationId.mockResolvedValue(undefined);
    h.findByOrgAndOwner.mockImplementation(async (_organizationId: string, owner: string) =>
      owner === "custom-owner" ? customInstallation : legacyInstallation,
    );
    h.resolveSourceCredentials.mockResolvedValue({
      installation: customInstallation,
      source: {
        id: "src_custom",
        apiBaseUrl: "https://github.enterprise.test/api/v3",
      },
      credentials: {
        appId: 123,
        privateKeyPem: "private-key",
        apiBaseUrl: "https://github.enterprise.test/api/v3",
      },
      secrets: { privateKeyPem: "private-key", webhookSecret: "webhook-secret" },
    });
    h.appFetch.mockResolvedValue({
      token: "custom-installation-token",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  });

  it("does not treat a source-less row as mintable just because another owner has a custom App", async () => {
    await expect(resolveGitHubAuthMode(ctx)).resolves.toBe("app");
    await expect(getInstallationId(ctx, "legacy-owner")).resolves.toBeNull();
    await expect(getInstallationToken(ctx, "legacy-owner")).resolves.toBeNull();
    expect(h.appFetch).not.toHaveBeenCalled();
  });

  it("mints directly with the custom source that covers the owner", async () => {
    await expect(getInstallationToken(ctx, "custom-owner")).resolves.toBe(
      "custom-installation-token",
    );
    expect(h.appFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 123,
        apiBaseUrl: "https://github.enterprise.test/api/v3",
      }),
      "/app/installations/88/access_tokens",
      { method: "POST" },
    );
  });

  it("keeps Openship Cloud authoritative for an owner not covered by the custom App", async () => {
    h.cloudConnected.mockResolvedValue(true);
    h.cloudInstallations.mockResolvedValue([
      { id: 99, login: "legacy-owner", avatarUrl: "", type: "Organization" },
    ]);
    h.cloudInstallationToken.mockResolvedValue({
      token: "cloud-installation-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    await expect(getInstallationId(ctx, "legacy-owner")).resolves.toBe(99);
    await expect(getInstallationToken(ctx, "legacy-owner")).resolves.toBe(
      "cloud-installation-token",
    );
    expect(h.cloudInstallationToken).toHaveBeenCalledWith("legacy-owner", undefined);
    expect(h.appFetch).not.toHaveBeenCalled();
  });
});
