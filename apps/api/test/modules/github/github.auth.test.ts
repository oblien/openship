import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

const {
  getAccessToken,
  unlinkProvider,
  listMemberships,
  setStoredDeviceToken,
  setGithubCliDisabled,
  setGhCliOperatorOptedIn,
  isGithubCliDisabled,
  invalidateByPrefix,
} = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  unlinkProvider: vi.fn(),
  listMemberships: vi.fn(),
  setStoredDeviceToken: vi.fn(),
  setGithubCliDisabled: vi.fn(),
  setGhCliOperatorOptedIn: vi.fn(),
  isGithubCliDisabled: vi.fn(),
  invalidateByPrefix: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    gitInstallation: {
      findByOwner: vi.fn(),
    },
    account: { unlinkProvider },
    member: { listByUser: listMemberships },
  },
}));

vi.mock("../../../src/lib/auth", () => ({
  auth: {
    api: {
      getAccessToken,
    },
  },
}));

vi.mock("../../../src/config/env", () => ({
  env: {},
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({
  getLocalGhToken: vi.fn(),
  setStoredDeviceToken,
}));

vi.mock("../../../src/modules/settings/settings.service", () => ({
  setGithubCliDisabled,
  setGhCliOperatorOptedIn,
  isGithubCliDisabled,
}));

vi.mock("../../../src/lib/cache-store", () => ({
  cacheStore: vi.fn(async () => ({ invalidateByPrefix })),
}));

import { disconnectUser, getUserToken } from "../../../src/modules/github/github.auth";

beforeEach(() => {
  getAccessToken.mockReset();
  unlinkProvider.mockReset();
  listMemberships.mockReset().mockResolvedValue([]);
  setStoredDeviceToken.mockReset().mockResolvedValue(undefined);
  setGithubCliDisabled.mockReset().mockResolvedValue(undefined);
  setGhCliOperatorOptedIn.mockReset().mockResolvedValue(undefined);
  isGithubCliDisabled.mockReset().mockResolvedValue(false);
  invalidateByPrefix.mockReset().mockResolvedValue(undefined);
});

describe("getUserToken", () => {
  it("uses Better Auth to resolve the GitHub OAuth token", async () => {
    getAccessToken.mockResolvedValue({ accessToken: "github-user-token" });

    await expect(getUserToken("user-1")).resolves.toBe("github-user-token");
    expect(getAccessToken).toHaveBeenCalledWith({
      body: {
        providerId: "github",
        userId: "user-1",
      },
    });
  });

  it("returns null when the GitHub account is not linked", async () => {
    getAccessToken.mockRejectedValue(
      new APIError("BAD_REQUEST", {
        message: "Account not found",
        code: "ACCOUNT_NOT_FOUND",
      }),
    );

    await expect(getUserToken("user-1")).resolves.toBeNull();
  });

  it("rethrows unexpected Better Auth failures", async () => {
    getAccessToken.mockRejectedValue(new Error("boom"));

    await expect(getUserToken("user-1")).rejects.toThrow("boom");
  });
});

describe("disconnectUser", () => {
  it("clears the stored credential and both local authorization gates", async () => {
    await disconnectUser("user-1", "cli");

    expect(setGithubCliDisabled).toHaveBeenCalledWith("user-1", true);
    expect(setGhCliOperatorOptedIn).toHaveBeenCalledWith("user-1", false);
    expect(setStoredDeviceToken).toHaveBeenCalledWith(null);
  });

  it("fails instead of reporting a successful disconnect when token removal fails", async () => {
    setStoredDeviceToken.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(disconnectUser("user-1", "cli")).rejects.toThrow("database unavailable");
  });
});
