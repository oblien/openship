import { beforeEach, describe, expect, it, vi } from "vitest";

const { linkSocialAccount, getGitHubAuthMode, getLocalGhStatus, isGithubCliDisabled } = vi.hoisted(
  () => ({
    linkSocialAccount: vi.fn(),
    getGitHubAuthMode: vi.fn(),
    getLocalGhStatus: vi.fn(),
    isGithubCliDisabled: vi.fn(),
  }),
);

vi.mock("../../../src/lib/auth", () => ({
  auth: {
    api: {
      linkSocialAccount,
    },
  },
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  getGitHubAuthMode,
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({ getLocalGhStatus }));
vi.mock("../../../src/modules/github/github.service", () => ({}));
vi.mock("../../../src/modules/settings/settings.service", () => ({ isGithubCliDisabled }));

import { connectRedirect, getLocalStatus } from "../../../src/modules/github/github.controller";

function createContext(headers: Headers) {
  return {
    req: {
      raw: {
        headers,
      },
    },
    redirect: (url: string) =>
      new Response(null, {
        status: 302,
        headers: {
          location: url,
        },
      }),
    text: (body: string, status = 200) => new Response(body, { status }),
  } as any;
}

describe("connectRedirect", () => {
  beforeEach(() => {
    getGitHubAuthMode.mockReset();
    linkSocialAccount.mockReset();
    getLocalGhStatus.mockReset();
    isGithubCliDisabled.mockReset().mockResolvedValue(false);
  });

  it("reports local GitHub auth unavailable after the user disconnects it", async () => {
    getGitHubAuthMode.mockReturnValue("cli");
    isGithubCliDisabled.mockResolvedValue(true);
    getLocalGhStatus.mockResolvedValue({
      available: true,
      login: "stale-login",
      method: "host-cli",
    });
    const ctx = {
      get: () => ({ userId: "user-1" }),
      json: (body: unknown) => body,
    } as any;

    await expect(getLocalStatus(ctx)).resolves.toEqual({
      available: false,
      method: null,
      activeMode: "cli",
    });
    expect(getLocalGhStatus).not.toHaveBeenCalled();
  });

  it("starts a GitHub link flow and forwards the OAuth state cookie", async () => {
    getGitHubAuthMode.mockReturnValue("oauth");
    const headers = new Headers({ cookie: "openship.session_token=test" });

    linkSocialAccount.mockResolvedValue(
      new Response(
        JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test" }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": "oauth_state=test-state; Path=/; HttpOnly",
          },
        },
      ),
    );

    const response = await connectRedirect(createContext(headers));

    expect(linkSocialAccount).toHaveBeenCalledWith({
      body: {
        provider: "github",
        callbackURL: "/auth/callback/close",
        errorCallbackURL: "/auth/callback/close",
        disableRedirect: true,
      },
      headers,
      asResponse: true,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?client_id=test",
    );
    expect(response.headers.get("set-cookie")).toContain("oauth_state=test-state");
  });

  it("uses the install callback when app mode needs GitHub install flow", async () => {
    getGitHubAuthMode.mockReturnValue("app");

    linkSocialAccount.mockResolvedValue(
      new Response(
        JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test" }),
        {
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    await connectRedirect(createContext(new Headers()));

    expect(linkSocialAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          callbackURL: "/auth/callback/install",
        }),
      }),
    );
  });
});
