import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

const { getAccessToken } = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
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
  });

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