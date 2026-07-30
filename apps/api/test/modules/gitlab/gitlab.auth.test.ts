import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";

const {
  getAccessToken,
  findSettingsByUser,
  updateSettings,
  upsertSettings,
  unlinkProvider,
  decrypt,
  encrypt,
  glFetchSoft,
  envMock,
} = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  findSettingsByUser: vi.fn(),
  updateSettings: vi.fn(),
  upsertSettings: vi.fn(),
  unlinkProvider: vi.fn(),
  decrypt: vi.fn((s: string) => s.replace(/^ENC:/, "")),
  encrypt: vi.fn((s: string) => `ENC:${s}`),
  glFetchSoft: vi.fn(),
  envMock: {
    GITLAB_CLIENT_ID: "id",
    GITLAB_CLIENT_SECRET: "secret",
    GITLAB_BASE_URL: "https://gitlab.com",
    CLOUD_MODE: false,
  },
}));

vi.mock("../../../src/config/env", () => ({ env: envMock }));
vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { getAccessToken } },
}));
vi.mock("@repo/db", () => ({
  repos: {
    settings: {
      findByUser: findSettingsByUser,
      update: updateSettings,
      upsert: upsertSettings,
    },
    account: { unlinkProvider },
  },
}));
vi.mock("../../../src/lib/encryption", () => ({ decrypt, encrypt }));
vi.mock("../../../src/modules/gitlab/gitlab.http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/gitlab/gitlab.http")>();
  return {
    ...actual,
    glFetchSoft,
  };
});
vi.mock("@repo/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/core")>();
  return { ...actual, generateId: () => "settings-id" };
});

import {
  isGitlabOAuthConfigured,
  getUserGitlabToken,
  readUserGitlabPat,
  resolveUserGitlabBaseUrl,
  saveUserGitlabPat,
  clearUserGitlabPat,
  resolveGitlabUserCredential,
  getGitlabConnectionState,
  disconnectGitlabUser,
} from "../../../src/modules/gitlab/gitlab.auth";

beforeEach(() => {
  vi.clearAllMocks();
  envMock.GITLAB_CLIENT_ID = "id";
  envMock.GITLAB_CLIENT_SECRET = "secret";
  envMock.GITLAB_BASE_URL = "https://gitlab.com";
  envMock.CLOUD_MODE = false;
  findSettingsByUser.mockResolvedValue(null);
  decrypt.mockImplementation((s: string) => s.replace(/^ENC:/, ""));
  encrypt.mockImplementation((s: string) => `ENC:${s}`);
});

describe("isGitlabOAuthConfigured", () => {
  it("requires both client id and secret", () => {
    expect(isGitlabOAuthConfigured()).toBe(true);
    envMock.GITLAB_CLIENT_SECRET = undefined as any;
    expect(isGitlabOAuthConfigured()).toBe(false);
  });
});

describe("getUserGitlabToken", () => {
  it("uses Better Auth for providerId=gitlab", async () => {
    getAccessToken.mockResolvedValue({ accessToken: "gl-oauth" });
    await expect(getUserGitlabToken("user-1")).resolves.toBe("gl-oauth");
    expect(getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "gitlab", userId: "user-1" },
    });
  });

  it("returns null when account is not linked", async () => {
    getAccessToken.mockRejectedValue(
      new APIError("BAD_REQUEST", {
        message: "Account not found",
        code: "ACCOUNT_NOT_FOUND",
      }),
    );
    await expect(getUserGitlabToken("user-1")).resolves.toBeNull();
  });

  it("rethrows unexpected failures", async () => {
    getAccessToken.mockRejectedValue(new Error("boom"));
    await expect(getUserGitlabToken("user-1")).rejects.toThrow("boom");
  });
});

describe("readUserGitlabPat / resolveUserGitlabBaseUrl", () => {
  it("decrypts a stored PAT", async () => {
    findSettingsByUser.mockResolvedValue({
      gitlabCloneTokenEncrypted: "ENC:pat-value",
    });
    await expect(readUserGitlabPat("u1")).resolves.toBe("pat-value");
  });

  it("returns null when decrypt fails", async () => {
    findSettingsByUser.mockResolvedValue({
      gitlabCloneTokenEncrypted: "bad",
    });
    decrypt.mockImplementation(() => {
      throw new Error("bad cipher");
    });
    await expect(readUserGitlabPat("u1")).resolves.toBeNull();
  });

  it("prefers per-user gitlabBaseUrl over env default", async () => {
    findSettingsByUser.mockResolvedValue({
      gitlabBaseUrl: "https://gitlab.example.com",
    });
    await expect(resolveUserGitlabBaseUrl("u1")).resolves.toBe(
      "https://gitlab.example.com",
    );
  });

  it("falls back to configured GITLAB_BASE_URL", async () => {
    findSettingsByUser.mockResolvedValue(null);
    await expect(resolveUserGitlabBaseUrl("u1")).resolves.toBe("https://gitlab.com");
  });
});

describe("saveUserGitlabPat / clearUserGitlabPat", () => {
  it("updates existing settings with encrypted PAT and normalized base URL", async () => {
    findSettingsByUser.mockResolvedValue({ id: "s1" });
    await saveUserGitlabPat("u1", "glpat-xxx", "gitlab.example.com/foo");
    expect(updateSettings).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        gitlabCloneTokenEncrypted: "ENC:glpat-xxx",
        gitlabBaseUrl: "https://gitlab.example.com",
      }),
    );
  });

  it("upserts when the user has no settings row", async () => {
    findSettingsByUser.mockResolvedValue(null);
    await saveUserGitlabPat("u1", "glpat-xxx", "https://gitlab.com");
    expect(upsertSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "settings-id",
        userId: "u1",
        gitlabCloneTokenEncrypted: "ENC:glpat-xxx",
      }),
    );
  });

  it("refuses CLOUD_MODE-disallowed origins at persist time", async () => {
    envMock.CLOUD_MODE = true;
    await expect(
      saveUserGitlabPat("u1", "glpat-xxx", "https://evil.example.com"),
    ).rejects.toThrow(/not allowed/i);
  });

  it("clears PAT fields", async () => {
    await clearUserGitlabPat("u1");
    expect(updateSettings).toHaveBeenCalledWith("u1", {
      gitlabCloneTokenEncrypted: null,
      gitlabCloneTokenSetAt: null,
      gitlabBaseUrl: null,
    });
  });
});

describe("resolveGitlabUserCredential / getGitlabConnectionState", () => {
  it("prefers PAT over OAuth", async () => {
    findSettingsByUser.mockResolvedValue({
      gitlabCloneTokenEncrypted: "ENC:pat",
    });
    getAccessToken.mockResolvedValue({ accessToken: "oauth" });
    await expect(resolveGitlabUserCredential("u1")).resolves.toEqual({
      token: "pat",
      mode: "pat",
    });
  });

  it("returns disconnected when no credential", async () => {
    const state = await getGitlabConnectionState("u1");
    expect(state).toMatchObject({
      connected: false,
      mode: null,
      login: null,
      oauthConfigured: true,
      baseUrl: "https://gitlab.com",
    });
  });

  it("returns connected state from /user when credential works", async () => {
    findSettingsByUser.mockResolvedValue({
      gitlabCloneTokenEncrypted: "ENC:pat",
    });
    glFetchSoft.mockResolvedValue({
      username: "jane",
      avatar_url: "https://avatar",
    });
    const state = await getGitlabConnectionState("u1");
    expect(state).toMatchObject({
      connected: true,
      mode: "pat",
      login: "jane",
      avatarUrl: "https://avatar",
    });
  });

  it("treats invalid credential as disconnected", async () => {
    getAccessToken.mockResolvedValue({ accessToken: "oauth" });
    glFetchSoft.mockResolvedValue(null);
    const state = await getGitlabConnectionState("u1");
    expect(state.connected).toBe(false);
  });
});

describe("disconnectGitlabUser", () => {
  it("unlinks oauth and clears PAT for source=all", async () => {
    await disconnectGitlabUser("u1", "all");
    expect(unlinkProvider).toHaveBeenCalledWith("u1", "gitlab");
    expect(updateSettings).toHaveBeenCalled();
  });

  it("only unlinks oauth when source=oauth", async () => {
    await disconnectGitlabUser("u1", "oauth");
    expect(unlinkProvider).toHaveBeenCalledWith("u1", "gitlab");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("only clears PAT when source=pat", async () => {
    await disconnectGitlabUser("u1", "pat");
    expect(unlinkProvider).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalled();
  });
});
