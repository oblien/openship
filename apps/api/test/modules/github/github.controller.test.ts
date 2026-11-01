import { beforeEach, describe, expect, it, vi } from "vitest";

const { linkSocialAccount, getGitHubAuthMode } = vi.hoisted(() => ({
  linkSocialAccount: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/auth", () => ({
  auth: {
    api: {
      linkSocialAccount,
    },
  },
}));

vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  getGitHubAuthMode,
}));

vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({}));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({}));

import { connectRedirect } from "../../../src/modules/github/github.controller";

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
  });

  it("starts a GitHub link flow and forwards the OAuth state cookie", async () => {
    getGitHubAuthMode.mockReturnValue("oauth");
    const headers = new Headers({ cookie: "openship.session_token=test" });

    linkSocialAccount.mockResolvedValue(
      new Response(JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test" }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "oauth_state=test-state; Path=/; HttpOnly",
        },
      }),
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
      new Response(JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test" }), {
        headers: {
          "content-type": "application/json",
        },
      }),
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
