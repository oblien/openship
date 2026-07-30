import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  linkSocialAccount,
  isGitlabOAuthConfigured,
  getGitlabConnectionState,
  saveUserGitlabPat,
  disconnectGitlabUser,
  resolveUserGitlabBaseUrl,
  glFetchSoft,
  parseAllowedGitlabBaseUrl,
  getRequestContext,
  findByIdInOrganization,
  resolveCloneToken,
  getProject,
  resolveApiPublicUrl,
} = vi.hoisted(() => ({
  linkSocialAccount: vi.fn(),
  isGitlabOAuthConfigured: vi.fn(),
  getGitlabConnectionState: vi.fn(),
  saveUserGitlabPat: vi.fn(),
  disconnectGitlabUser: vi.fn(),
  resolveUserGitlabBaseUrl: vi.fn(),
  glFetchSoft: vi.fn(),
  parseAllowedGitlabBaseUrl: vi.fn(),
  getRequestContext: vi.fn(),
  findByIdInOrganization: vi.fn(),
  resolveCloneToken: vi.fn(),
  getProject: vi.fn(),
  resolveApiPublicUrl: vi.fn(() => "https://api.example.com"),
}));

vi.mock("../../../src/lib/auth", () => ({
  auth: { api: { linkSocialAccount } },
}));

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext,
}));

vi.mock("../../../src/lib/public-url", () => ({
  resolveApiPublicUrl,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findByIdInOrganization },
  },
}));

vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  isGitlabOAuthConfigured,
  getGitlabConnectionState,
  saveUserGitlabPat,
  disconnectGitlabUser,
  resolveUserGitlabBaseUrl,
}));

vi.mock("../../../src/modules/gitlab/gitlab.http", () => ({
  glFetchSoft,
  gitlabWebBase: () => "https://gitlab.com",
  parseAllowedGitlabBaseUrl,
}));

vi.mock("../../../src/modules/gitlab/gitlab.service", () => ({
  resolveCloneToken,
  getProject,
  listNamespaces: vi.fn(),
  listProjects: vi.fn(),
  listBranches: vi.fn(),
  registerWebhook: vi.fn(),
  parseGitlabRepoUrl: vi.fn(),
}));

import {
  connect,
  connectRedirect,
  disconnect,
  getCloneToken,
  getStatus,
} from "../../../src/modules/gitlab/gitlab.controller";

function createContext(opts: {
  headers?: Headers;
  query?: Record<string, string>;
  param?: Record<string, string>;
  body?: unknown;
} = {}) {
  const headers = opts.headers ?? new Headers();
  return {
    req: {
      raw: { headers },
      json: async () => opts.body ?? {},
      query: (key: string) => opts.query?.[key],
      param: (key: string) => opts.param?.[key],
    },
    json: (body: unknown, status = 200) =>
      Response.json(body, { status }),
    redirect: (url: string) =>
      new Response(null, {
        status: 302,
        headers: { location: url },
      }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRequestContext.mockReturnValue({
    userId: "u1",
    organizationId: "org-1",
  });
  isGitlabOAuthConfigured.mockReturnValue(true);
  resolveApiPublicUrl.mockReturnValue("https://api.example.com");
  parseAllowedGitlabBaseUrl.mockImplementation((v: string) =>
    v ? `https://${v.replace(/^https?:\/\//, "").split("/")[0]}` : null,
  );
});

describe("getStatus", () => {
  it("returns connection state", async () => {
    getGitlabConnectionState.mockResolvedValue({
      connected: true,
      mode: "oauth",
      login: "jane",
    });
    const res = await getStatus(createContext());
    const body = await res.json();
    expect(body).toMatchObject({ success: true, connected: true, login: "jane" });
  });
});

describe("connect", () => {
  it("rejects PAT connect without a token", async () => {
    const res = await connect(createContext({ body: { mode: "pat" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token is required/i);
  });

  it("saves a validated PAT", async () => {
    glFetchSoft.mockResolvedValue({ username: "jane" });
    const res = await connect(
      createContext({
        body: { mode: "pat", token: "glpat-xxx", baseUrl: "gitlab.example.com" },
      }),
    );
    expect(res.status).toBe(200);
    expect(saveUserGitlabPat).toHaveBeenCalledWith(
      "u1",
      "glpat-xxx",
      "https://gitlab.example.com",
    );
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      connected: true,
      mode: "pat",
      login: "jane",
    });
  });

  it("rejects invalid PAT", async () => {
    glFetchSoft.mockResolvedValue(null);
    const res = await connect(
      createContext({ body: { token: "bad" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid GitLab personal access token/i);
  });

  it("returns redirect flow for OAuth when not yet connected", async () => {
    getGitlabConnectionState.mockResolvedValue({
      connected: false,
      mode: null,
    });
    const res = await connect(createContext({ body: {} }));
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      connected: false,
      flow: "redirect",
    });
  });

  it("short-circuits when already OAuth-connected", async () => {
    getGitlabConnectionState.mockResolvedValue({
      connected: true,
      mode: "oauth",
    });
    const res = await connect(createContext({ body: {} }));
    const body = await res.json();
    expect(body).toEqual({ success: true, connected: true });
  });

  it("errors when OAuth is not configured", async () => {
    isGitlabOAuthConfigured.mockReturnValue(false);
    const res = await connect(createContext({ body: {} }));
    expect(res.status).toBe(400);
  });
});

describe("connectRedirect", () => {
  it("starts a GitLab link flow and forwards the OAuth state cookie", async () => {
    const headers = new Headers({ cookie: "openship.session_token=test" });
    linkSocialAccount.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://gitlab.com/oauth/authorize?client_id=test",
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": "oauth_state=test-state; Path=/; HttpOnly",
          },
        },
      ),
    );

    const response = await connectRedirect(createContext({ headers }));

    expect(linkSocialAccount).toHaveBeenCalledWith({
      body: {
        provider: "gitlab",
        callbackURL: "https://api.example.com/auth/callback/close",
        disableRedirect: true,
      },
      headers,
      asResponse: true,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://gitlab.com/oauth/authorize?client_id=test",
    );
    expect(response.headers.get("set-cookie")).toContain("oauth_state=test-state");
  });

  it("rejects when OAuth is not configured", async () => {
    isGitlabOAuthConfigured.mockReturnValue(false);
    const res = await connectRedirect(createContext());
    expect(res.status).toBe(400);
  });
});

describe("disconnect", () => {
  it("forwards source to disconnectGitlabUser", async () => {
    const res = await disconnect(createContext({ body: { source: "pat" } }));
    expect(disconnectGitlabUser).toHaveBeenCalledWith("u1", "pat");
    const body = await res.json();
    expect(body).toEqual({ success: true, connected: false });
  });
});

describe("getCloneToken — org + provider guard", () => {
  it("404s when Openship project is outside the caller's org", async () => {
    findByIdInOrganization.mockResolvedValue(null);
    const res = await getCloneToken(
      createContext({
        param: { projectId: "99" },
        query: { projectId: "openship-p1" },
      }),
    );
    expect(res.status).toBe(404);
    expect(resolveCloneToken).not.toHaveBeenCalled();
  });

  it("rejects a non-GitLab Openship project (IDOR / provider guard)", async () => {
    findByIdInOrganization.mockResolvedValue({
      id: "openship-p1",
      gitProvider: "github",
    });
    const res = await getCloneToken(
      createContext({
        param: { projectId: "99" },
        query: { projectId: "openship-p1" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not linked to GitLab/i);
    expect(resolveCloneToken).not.toHaveBeenCalled();
  });

  it("returns clone credential for an in-org GitLab project", async () => {
    findByIdInOrganization.mockResolvedValue({
      id: "openship-p1",
      gitProvider: "gitlab",
    });
    resolveCloneToken.mockResolvedValue({
      token: "tok",
      username: "oauth2",
      cloneUrlPrefix: "https://gitlab.com",
    });
    getProject.mockResolvedValue({
      cloneUrl: "https://gitlab.com/acme/site.git",
    });

    const res = await getCloneToken(
      createContext({
        param: { projectId: "99" },
        query: { projectId: "openship-p1" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      token: "tok",
      username: "oauth2",
    });
    expect(body.cloneUrl).toContain("oauth2:tok@");
  });
});
