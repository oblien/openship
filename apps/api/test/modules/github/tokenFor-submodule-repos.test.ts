import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * oblien/openship#979: TokenContext.extraRepositories widens the App
 * installation mint to same-owner submodules, but only for repos the caller is
 * authorized for through the same github-access gate, and never by default.
 */

const { envMock, findProjectById, findSettingsByUser, decrypt, ghAuth, canUseGitHubRepo, getLocalGhToken } =
  vi.hoisted(() => ({
    envMock: { CLOUD_MODE: false, GITHUB_AUTH_MODE: undefined } as {
      CLOUD_MODE: boolean;
      GITHUB_AUTH_MODE?: string;
    },
    findProjectById: vi.fn(),
    findSettingsByUser: vi.fn(),
    decrypt: vi.fn((s: string) => s.replace(/^ENC:/, "")),
    ghAuth: {
      getInstallationToken: vi.fn(),
      getInstallationId: vi.fn(),
      getInstallationIdByOrg: vi.fn(),
      getUserToken: vi.fn(),
    },
    canUseGitHubRepo: vi.fn(),
    getLocalGhToken: vi.fn(),
  }));

vi.mock("@repo/platform/engine/config/env", () => ({ env: envMock }));
vi.mock("@repo/db", () => ({
  repos: {
    server: { findLocal: async () => undefined },
    project: { findById: findProjectById },
    settings: { findByUser: findSettingsByUser },
  },
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt }));
vi.mock("@repo/platform/engine/modules/github/github.auth", () => ghAuth);
vi.mock("@repo/platform/engine/modules/github/github-access", () => ({ canUseGitHubRepo }));
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({ getLocalGhToken }));

import { tokenFor } from "@repo/platform/engine/modules/github/github.token";
import { MAX_SUBMODULE_REPOS } from "@repo/platform/engine/modules/github/gitmodules";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxOrg = { userId: "u1", organizationId: "o1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  envMock.CLOUD_MODE = false;
  envMock.GITHUB_AUTH_MODE = undefined;
  findProjectById.mockResolvedValue(null);
  findSettingsByUser.mockResolvedValue(null);
  getLocalGhToken.mockResolvedValue(null);
  ghAuth.getUserToken.mockResolvedValue(null);
  ghAuth.getInstallationToken.mockResolvedValue("apptok");
  ghAuth.getInstallationId.mockResolvedValue(42);
  ghAuth.getInstallationIdByOrg.mockResolvedValue(42);
  // Default: gate grants, so the App branch mints and we can inspect its args.
  canUseGitHubRepo.mockResolvedValue(true);
});

describe("tokenFor extraRepositories (submodule expansion)", () => {
  it("mints exactly [repo] when there are no extras (upstream behavior)", async () => {
    await tokenFor(ctxOrg, "remote", { owner: "acme", repo: "webapp" });
    expect(ghAuth.getInstallationToken).toHaveBeenCalledWith(ctxOrg, "acme", undefined, { repositories: ["webapp"] });
  });

  it("unions the parent with authorized extras, parent first", async () => {
    const res = await tokenFor(ctxOrg, "remote", {
      owner: "acme",
      repo: "webapp",
      extraRepositories: ["shared-auth", "webapp", "shared-ui"],
    });
    expect(res).toEqual({ token: "apptok", source: "app-installation", repositories: ["webapp", "shared-auth", "shared-ui"] });
    expect(ghAuth.getInstallationToken).toHaveBeenCalledWith(ctxOrg, "acme", undefined, {
      repositories: ["webapp", "shared-auth", "shared-ui"],
    });
    // each extra went through the gate for THAT repo
    const gated = canUseGitHubRepo.mock.calls.map((c) => c[1].repo);
    expect(gated).toEqual(expect.arrayContaining(["webapp", "shared-auth", "shared-ui"]));
  });

  it("drops extras the caller is not authorized for", async () => {
    canUseGitHubRepo.mockImplementation(async (_c: unknown, t: { repo?: string }) => t.repo !== "secret-sub");
    const result = await tokenFor(ctxOrg, "remote", {
      owner: "acme",
      repo: "webapp",
      extraRepositories: ["shared-auth", "secret-sub"],
    });
    expect(ghAuth.getInstallationToken).toHaveBeenCalledWith(ctxOrg, "acme", undefined, {
      repositories: ["webapp", "shared-auth"],
    });
    expect(result?.repositories).toEqual(["webapp", "shared-auth"]);
  });

  it("ignores extras when the parent repo itself is not authorized", async () => {
    canUseGitHubRepo.mockResolvedValue(false);
    const res = await tokenFor(ctxOrg, "remote", { owner: "acme", repo: "webapp", extraRepositories: ["x"] });
    expect(res).toBeNull();
    expect(ghAuth.getInstallationToken).not.toHaveBeenCalled();
  });

  it("caps the mint at parent + MAX_SUBMODULE_REPOS", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `sub-${i}`);
    await tokenFor(ctxOrg, "remote", { owner: "acme", repo: "webapp", extraRepositories: many });
    const repos = ghAuth.getInstallationToken.mock.calls[0][3].repositories;
    expect(repos).toHaveLength(MAX_SUBMODULE_REPOS + 1);
    expect(repos[0]).toBe("webapp");
  });
});
