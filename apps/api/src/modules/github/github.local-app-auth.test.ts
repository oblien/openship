import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stateCreate: vi.fn(),
  statePurge: vi.fn(),
  listByOrganization: vi.fn(),
  findByOrgAndOwner: vi.fn(),
  findByOwner: vi.fn(),
  replaceForUserInOrganization: vi.fn(),
  sourceFindDefault: vi.fn(),
  sourceListActive: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    CLOUD_MODE: false,
    GITHUB_AUTH_MODE: "auto",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "self-hosted-openship",
    GITHUB_PRIVATE_KEY: undefined,
    GITHUB_PRIVATE_KEY_BASE64: undefined,
  },
  localGitHubAppConfiguration: { configured: true, intended: true, missing: [] },
}));
vi.mock("@repo/db", () => ({
  repos: {
    githubInstallState: { create: h.stateCreate, purgeExpired: h.statePurge },
    gitInstallation: {
      listByOrganization: h.listByOrganization,
      findByOrgAndOwner: h.findByOrgAndOwner,
      findByOwner: h.findByOwner,
      replaceForUserInOrganization: h.replaceForUserInOrganization,
    },
    gitSource: {
      findDefault: h.sourceFindDefault,
      listActiveByOrganization: h.sourceListActive,
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
vi.mock("@repo/platform/engine/lib/org-actor", () => ({ resolveOrgOwner: vi.fn(async () => null) }));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({
  ghFetch: vi.fn(),
  ghFetchPublic: vi.fn(),
  ghFetchSoft: vi.fn(),
}));

import {
  getGitHubAuthMode,
  getInstallationId,
  getUserInstallations,
  resolveGitHubAuthMode,
  resolveInstallUrl,
} from "@repo/platform/engine/modules/github/github.auth";

const ctx = { userId: "user_1", organizationId: "org_1", role: "owner" } as any;

describe("self-hosted local GitHub App auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cacheGet.mockResolvedValue(null);
    h.cacheSet.mockResolvedValue(undefined);
    h.statePurge.mockResolvedValue(0);
    h.stateCreate.mockResolvedValue(undefined);
    h.listByOrganization.mockResolvedValue([]);
    h.findByOrgAndOwner.mockResolvedValue(null);
    h.sourceFindDefault.mockResolvedValue(undefined);
    h.sourceListActive.mockResolvedValue([]);
  });

  it("selects the complete local App in auto mode without a cloud probe", async () => {
    expect(getGitHubAuthMode()).toBe("app");
    await expect(resolveGitHubAuthMode(ctx)).resolves.toBe("app");
  });

  it("issues a persisted user/workspace-bound install URL", async () => {
    const result = await resolveInstallUrl(ctx);

    expect(result.url).toMatch(
      /^https:\/\/github\.com\/apps\/self-hosted-openship\/installations\/new\?state=/,
    );
    expect(result.state).toHaveLength(32);
    expect(h.stateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: result.state,
        userId: "user_1",
        organizationId: "org_1",
      }),
    );
  });

  it("lists only installations claimed by the active workspace", async () => {
    h.listByOrganization.mockResolvedValue([
      {
        installationId: 42,
        owner: "acme",
        ownerType: "Organization",
        providerOwnerId: "700",
      },
    ]);

    const rows = await getUserInstallations(ctx);

    expect(rows.map((row) => row.id)).toEqual([42]);
    expect(h.listByOrganization).toHaveBeenCalledWith("org_1");
    expect(h.replaceForUserInOrganization).not.toHaveBeenCalled();
  });

  it("never falls back to the user's installation from another workspace", async () => {
    await expect(getInstallationId(ctx, "acme")).resolves.toBeNull();

    expect(h.findByOrgAndOwner).toHaveBeenCalledWith("org_1", "acme");
    expect(h.findByOwner).not.toHaveBeenCalled();
  });
});
