import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getLocalGhStatus` is the ONE health probe for the instance's git identity:
 * is there a credential, how was it established, and does GitHub still take it?
 *
 * The distinction under test is between the two ways a verify can fail. A 401/403
 * is GitHub refusing the credential — actionable, and clones keep failing until
 * it's replaced. Anything else (5xx, captive proxy, DNS, offline) is GitHub not
 * answering, where reporting "your token is invalid" would send an operator off
 * to revoke a perfectly good credential. Both used to collapse into a bare
 * `available: false`, which was also what "nothing connected" looked like.
 */

const { getGitHubAuthMode } = vi.hoisted(() => ({ getGitHubAuthMode: vi.fn() }));
const { instanceSettingsGet } = vi.hoisted(() => ({ instanceSettingsGet: vi.fn() }));
const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn() }));
const { cacheGet, cacheSet, cacheDelete } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({ getGitHubAuthMode }));

vi.mock("../../../src/modules/github/github.http", () => ({ ghFetchSoft: vi.fn() }));

vi.mock("@repo/db", () => ({
  repos: { instanceSettings: { get: instanceSettingsGet, upsert: vi.fn() } },
}));

vi.mock("../../../src/lib/encryption", () => ({ decrypt, encrypt: vi.fn() }));

vi.mock("../../../src/lib/system-debug", () => ({ systemDebug: vi.fn() }));

vi.mock("../../../src/lib/cache-store", () => ({
  cacheStore: vi.fn(async () => ({ get: cacheGet, set: cacheSet, delete: cacheDelete })),
}));

// Not CLOUD_MODE → the gh path is live (the SaaS hard-floor is covered elsewhere).
vi.mock("../../../src/config/env", () => ({ env: {}, runtimeTarget: { id: "local" } }));

vi.mock("@octokit/auth-oauth-device", () => ({ createOAuthDeviceAuth: vi.fn() }));

import { getLocalGhStatus } from "../../../src/modules/github/github.local-auth";

/** GitHub's /user answering with `status`. */
function githubUserReturns(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  getGitHubAuthMode.mockReset();
  instanceSettingsGet.mockReset();
  decrypt.mockReset();
  cacheGet.mockReset();
  cacheSet.mockReset();

  getGitHubAuthMode.mockReturnValue("cli");
  cacheGet.mockResolvedValue(null);
  cacheSet.mockResolvedValue(undefined);
  // A PAT the operator pasted into Openship, stored encrypted. Present for every
  // case below, so the probe never falls through to the host `gh` binary.
  instanceSettingsGet.mockResolvedValue({
    ghDeviceTokenEncrypted: "sealed",
    ghDeviceTokenMethod: "token",
  });
  decrypt.mockReturnValue("ghp_live_token");
});

describe("getLocalGhStatus — credential health", () => {
  it("reports the identity and its method when GitHub accepts it", async () => {
    githubUserReturns(200, { login: "hydralerne", id: 7, avatar_url: "https://avatars/1" });

    const status = await getLocalGhStatus();

    expect(status.available).toBe(true);
    if (!status.available) throw new Error("unreachable");
    expect(status.login).toBe("hydralerne");
    expect(status.method).toBe("token");
    expect(status.checkedAt).toBeTruthy();
  });

  it("classifies a 401 as rejected and names the failing method", async () => {
    githubUserReturns(401);

    const status = await getLocalGhStatus();

    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.problem).toBe("rejected");
    expect(status.method).toBe("token");
  });

  it("classifies a 403 as rejected (scope removed / SSO revoked)", async () => {
    githubUserReturns(403);

    const status = await getLocalGhStatus();

    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.problem).toBe("rejected");
  });

  it("does NOT blame the credential for a 5xx", async () => {
    githubUserReturns(500);

    const status = await getLocalGhStatus();

    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.problem).toBe("unreachable");
  });

  it("does NOT blame the credential when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }),
    );

    const status = await getLocalGhStatus();

    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.problem).toBe("unreachable");
  });

  it("labels a device sign-in as device, not as the host's gh login", async () => {
    instanceSettingsGet.mockResolvedValue({
      ghDeviceTokenEncrypted: "sealed",
      ghDeviceTokenMethod: "device",
    });
    githubUserReturns(200, { login: "hydralerne", id: 7, avatar_url: "" });

    const status = await getLocalGhStatus();

    if (!status.available) throw new Error("unreachable");
    expect(status.method).toBe("device");
  });

  it("reports no credential — and no problem — when nothing is stored", async () => {
    // No stored token and no `gh` on this host: "nothing connected" is not a
    // fault, so `problem` must stay absent or the UI shows a phantom failure.
    instanceSettingsGet.mockResolvedValue(null);
    process.env.GH_BIN = "/nonexistent/gh-binary-for-test";
    process.env.GH_CONFIG_DIR = "/nonexistent/gh-config-for-test";
    githubUserReturns(200, {});

    try {
      const status = await getLocalGhStatus();

      expect(status.available).toBe(false);
      if (status.available) throw new Error("unreachable");
      expect(status.problem).toBeUndefined();
      expect(status.method).toBeNull();
    } finally {
      delete process.env.GH_BIN;
      delete process.env.GH_CONFIG_DIR;
    }
  });

  it("stays silent on the SaaS path when the mode is App/OAuth", async () => {
    getGitHubAuthMode.mockReturnValue("app");

    const status = await getLocalGhStatus();

    expect(status.available).toBe(false);
    if (status.available) throw new Error("unreachable");
    expect(status.problem).toBeUndefined();
    expect(status.method).toBeNull();
  });
});
