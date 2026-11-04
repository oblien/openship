import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

const { getAccessToken, findAccount } = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  findAccount: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    account: { findByProvider: findAccount },
    gitInstallation: {
      findByOwner: vi.fn(),
    },
  },
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: {
    api: {
      getAccessToken,
    },
  },
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {},
}));

vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  getLocalGhToken: vi.fn(),
}));

import { getUserToken } from "@repo/platform/engine/modules/github/github.auth";

describe("getUserToken", () => {
  beforeEach(() => {
    getAccessToken.mockReset();
    findAccount.mockReset().mockResolvedValue({ id: "local-account-1", accountId: "github-user-42" });
  });

  it("uses Better Auth to resolve the GitHub OAuth token", async () => {
    getAccessToken.mockResolvedValue({ accessToken: "github-user-token" });

    await expect(getUserToken("user-1")).resolves.toBe("github-user-token");
    expect(getAccessToken).toHaveBeenCalledWith({
      body: {
        accountId: "local-account-1",
        userId: "user-1",
      },
    });
  });

  it("returns null when the GitHub account is not linked", async () => {
    findAccount.mockResolvedValue(null);

    await expect(getUserToken("user-1")).resolves.toBeNull();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("returns null if the linked account disappears before token lookup", async () => {
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
