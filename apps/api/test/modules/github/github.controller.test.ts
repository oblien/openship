import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  linkSocialAccount,
  getGitHubAuthMode,
  resolveGitHubAuthMode,
  getUserStatus,
  resolveInstallUrl,
  resolveApiPublicUrl,
} = vi.hoisted(() => ({
  linkSocialAccount: vi.fn(),
  getGitHubAuthMode: vi.fn(),
  resolveGitHubAuthMode: vi.fn(),
  getUserStatus: vi.fn(),
  resolveInstallUrl: vi.fn(),
  resolveApiPublicUrl: vi.fn(),
}));

vi.mock("../../../src/lib/auth", () => ({
  auth: {
    api: {
      linkSocialAccount,
    },
  },
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  getGitHubAuthMode,
  resolveGitHubAuthMode,
  getUserStatus,
  resolveInstallUrl,
}));

vi.mock("../../../src/modules/github/github.local-auth", () => ({}));
vi.mock("../../../src/modules/github/github.service", () => ({}));
vi.mock("../../../src/lib/public-url", () => ({
  resolveApiPublicUrl,
}));

import { connect, connectRedirect } from "../../../src/modules/github/github.controller";

function createContext(headers: Headers, query: Record<string, string> = {}) {
  return {
    req: {
      raw: {
        headers,
      },
      query: (name: string) => query[name],
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
    resolveGitHubAuthMode.mockReset();
    getUserStatus.mockReset();
    resolveInstallUrl.mockReset();
    resolveApiPublicUrl.mockReset();
    resolveApiPublicUrl.mockReturnValue("https://api.example.com");
  });

  it("returns an absolute API URL for the OAuth handoff", async () => {
    resolveGitHubAuthMode.mockResolvedValue("app");
    getUserStatus.mockResolvedValue({ connected: false });
    resolveInstallUrl.mockResolvedValue({ state: "workspace nonce" });

    const response = await connect({
      get: (key: string) =>
        key === "ctx"
          ? {
              userId: "user-1",
              organizationId: "org-1",
            }
          : undefined,
      req: {
        json: async () => ({}),
      },
      json: (body: unknown) => Response.json(body),
    } as any);

    expect(await response.json()).toMatchObject({
      connected: false,
      flow: "redirect",
      url: "https://api.example.com/api/github/connect/redirect?install_state=workspace%20nonce",
    });
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

  it("preserves the workspace-bound install state across the OAuth callback", async () => {
    getGitHubAuthMode.mockReturnValue("app");
    linkSocialAccount.mockResolvedValue(
      new Response(JSON.stringify({ url: "https://github.com/login/oauth/authorize" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await connectRedirect(createContext(new Headers(), { install_state: "workspace nonce" }));

    expect(linkSocialAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          callbackURL: "/auth/callback/install?state=workspace%20nonce",
        }),
      }),
    );
  });
});
