import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  glFetch,
  requireTokenFor,
  tokenFor,
  resolveUserGitlabBaseUrl,
  resolveGitlabUserCredential,
  findById,
  updateProject,
  sharedGitlabWebhookUrl,
  encrypt,
  decrypt,
} = vi.hoisted(() => ({
  glFetch: vi.fn(),
  requireTokenFor: vi.fn(),
  tokenFor: vi.fn(),
  resolveUserGitlabBaseUrl: vi.fn(),
  resolveGitlabUserCredential: vi.fn(),
  findById: vi.fn(),
  updateProject: vi.fn(),
  sharedGitlabWebhookUrl: vi.fn(() => "https://api.example.com/webhooks/gitlab"),
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, "")),
}));

vi.mock("../../../src/modules/gitlab/gitlab.http", () => ({
  glFetch,
  gitlabWebBase: (base?: string | null) => base || "https://gitlab.com",
  gitlabApiBase: (base?: string | null) =>
    `${(base || "https://gitlab.com").replace(/\/$/, "")}/api/v4`,
}));

vi.mock("../../../src/modules/gitlab/gitlab.token", () => ({
  requireTokenFor,
  tokenFor,
}));

vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  resolveUserGitlabBaseUrl,
  resolveGitlabUserCredential,
}));

vi.mock("../../../src/lib/public-url", () => ({
  sharedGitlabWebhookUrl,
}));

vi.mock("../../../src/lib/encryption", () => ({
  encrypt,
  decrypt,
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById,
        update: updateProject,
      },
    },
  };
});

import {
  parseGitlabRepoUrl,
  splitPathWithNamespace,
  registerWebhook,
  resolveCloneToken,
} from "../../../src/modules/gitlab/gitlab.service";

const ctx = { userId: "u1", organizationId: "org-1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  requireTokenFor.mockResolvedValue({ token: "tok", source: "user-oauth" });
  resolveUserGitlabBaseUrl.mockResolvedValue("https://gitlab.com");
  resolveGitlabUserCredential.mockResolvedValue(null);
  tokenFor.mockResolvedValue(null);
  sharedGitlabWebhookUrl.mockReturnValue(
    "https://api.example.com/webhooks/gitlab",
  );
  encrypt.mockImplementation((v: string) => `enc:${v}`);
  decrypt.mockImplementation((v: string) => v.replace(/^enc:/, ""));
});

describe("parseGitlabRepoUrl", () => {
  it("parses https gitlab.com nested groups", () => {
    expect(
      parseGitlabRepoUrl("https://gitlab.com/group/sub/project.git"),
    ).toEqual({
      owner: "group/sub",
      repo: "project",
      host: "gitlab.com",
    });
  });

  it("parses ssh form", () => {
    expect(parseGitlabRepoUrl("git@gitlab.com:acme/app.git")).toEqual({
      owner: "acme",
      repo: "app",
      host: "gitlab.com",
    });
  });

  it("rejects github.com", () => {
    expect(parseGitlabRepoUrl("https://github.com/acme/app.git")).toBeNull();
  });

  it("parses self-hosted https when baseUrl is provided", () => {
    expect(
      parseGitlabRepoUrl("https://gitlab.example.com/acme/app.git", {
        baseUrl: "https://gitlab.example.com",
      }),
    ).toEqual({
      owner: "acme",
      repo: "app",
      host: "gitlab.example.com",
    });
  });

  it("rejects unrelated self-hosted hosts without matching baseUrl", () => {
    expect(
      parseGitlabRepoUrl("https://gitlab.other.com/acme/app.git"),
    ).toBeNull();
  });
});

describe("splitPathWithNamespace", () => {
  it("splits nested path", () => {
    expect(splitPathWithNamespace("group/sub/project")).toEqual({
      owner: "group/sub",
      repo: "project",
    });
  });

  it("rejects single-segment paths", () => {
    expect(splitPathWithNamespace("only-repo")).toBeNull();
  });
});

describe("registerWebhook", () => {
  it("POSTs a push hook with a minted secret", async () => {
    findById.mockResolvedValue(null);
    glFetch.mockResolvedValue({ id: 7, url: "https://api.example.com/webhooks/gitlab" });

    const result = await registerWebhook(ctx, 99, undefined, {
      projectId: "openship-p1",
    });

    expect(result).toEqual({
      hookId: 7,
      url: "https://api.example.com/webhooks/gitlab",
    });
    expect(updateProject).toHaveBeenCalledWith(
      "openship-p1",
      expect.objectContaining({ webhookSecret: expect.stringMatching(/^enc:/) }),
    );
    expect(glFetch).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        path: "/projects/99/hooks",
        method: "POST",
        params: expect.objectContaining({
          push_events: true,
          enable_ssl_verification: true,
        }),
      }),
    );
  });

  it("reuses an existing project webhook secret", async () => {
    findById.mockResolvedValue({ webhookSecret: "enc:existing-secret" });
    glFetch.mockResolvedValue({ id: 8 });

    await registerWebhook(ctx, 99, undefined, { projectId: "openship-p1" });

    expect(updateProject).not.toHaveBeenCalled();
    expect(glFetch).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        params: expect.objectContaining({ token: "existing-secret" }),
      }),
    );
  });

  it("maps 403 to a clear webhook-scope error", async () => {
    glFetch.mockRejectedValue(new Error("GitLab API 403 Forbidden"));
    await expect(registerWebhook(ctx, 99)).rejects.toThrow(/lacks permission/i);
  });

  it("updates an existing hook on 422 already-exists", async () => {
    glFetch
      .mockRejectedValueOnce(new Error("422 already exists"))
      .mockResolvedValueOnce([
        { id: 3, url: "https://api.example.com/webhooks/gitlab" },
      ])
      .mockResolvedValueOnce({});

    const result = await registerWebhook(ctx, 99);
    expect(result.hookId).toBe(3);
    expect(glFetch).toHaveBeenNthCalledWith(
      3,
      "tok",
      expect.objectContaining({
        path: "/projects/99/hooks/3",
        method: "PUT",
      }),
    );
  });
});

describe("resolveCloneToken", () => {
  it("prefers tokenFor when a project token exists", async () => {
    tokenFor.mockResolvedValue({ token: "proj", source: "project" });
    const result = await resolveCloneToken(ctx, "p1");
    expect(result).toEqual({
      token: "proj",
      username: "oauth2",
      cloneUrlPrefix: "https://gitlab.com",
    });
    expect(tokenFor).toHaveBeenCalledWith(ctx, "local", { projectId: "p1" });
    expect(resolveGitlabUserCredential).not.toHaveBeenCalled();
  });

  it("falls back to user credential when tokenFor is empty", async () => {
    resolveGitlabUserCredential.mockResolvedValue({
      token: "user-pat",
      mode: "pat",
    });
    const result = await resolveCloneToken(ctx);
    expect(result).toEqual({
      token: "user-pat",
      username: "oauth2",
      cloneUrlPrefix: "https://gitlab.com",
    });
  });

  it("returns null when no credential exists", async () => {
    await expect(resolveCloneToken(ctx)).resolves.toBeNull();
  });
});
