import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  tokenFor,
  requireTokenFor,
  isPublicGitlabProject,
  resolveUserGitlabBaseUrl,
} = vi.hoisted(() => ({
  tokenFor: vi.fn(),
  requireTokenFor: vi.fn(),
  isPublicGitlabProject: vi.fn(),
  resolveUserGitlabBaseUrl: vi.fn(),
}));

vi.mock("../../../src/modules/gitlab/gitlab.token", () => ({
  tokenFor,
  requireTokenFor,
}));
vi.mock("../../../src/modules/gitlab/gitlab.http", () => ({
  isPublicGitlabProject,
}));
vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  resolveUserGitlabBaseUrl,
}));

import { resolveBuildGitToken } from "../../../src/modules/gitlab/clone-auth";

const ctx = { userId: "u1", organizationId: "o1" } as any;
const base = {
  ctx,
  projectId: "p1",
  owner: "acme",
  repo: "app",
  gitlabProjectId: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
  tokenFor.mockResolvedValue(null);
  isPublicGitlabProject.mockResolvedValue(false);
  resolveUserGitlabBaseUrl.mockResolvedValue("https://gitlab.com");
  requireTokenFor.mockRejectedValue(
    Object.assign(new Error("No GitLab token"), {
      code: "NO_GITLAB_TOKEN",
      statusCode: 403,
    }),
  );
});

describe("resolveBuildGitToken — token wins", () => {
  it("returns oauth2 username with a resolved token (local)", async () => {
    tokenFor.mockResolvedValue({ token: "tok", source: "user-oauth" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local" });
    expect(res).toEqual({ token: "tok", tokenUsername: "oauth2" });
    expect(tokenFor).toHaveBeenCalledWith(ctx, "local", expect.objectContaining({
      projectId: "p1",
      projectGitlabId: 42,
    }));
    expect(isPublicGitlabProject).not.toHaveBeenCalled();
  });

  it("uses remote purpose for server builds", async () => {
    tokenFor.mockResolvedValue({ token: "tok", source: "project" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server" });
    expect(res).toEqual({ token: "tok", tokenUsername: "oauth2" });
    expect(tokenFor).toHaveBeenCalledWith(ctx, "remote", expect.anything());
  });
});

describe("resolveBuildGitToken — public project fallback", () => {
  it("returns empty credential for a public GitLab project", async () => {
    isPublicGitlabProject.mockResolvedValue(true);
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server" });
    expect(res).toEqual({});
    expect(resolveUserGitlabBaseUrl).toHaveBeenCalledWith("u1");
    expect(isPublicGitlabProject).toHaveBeenCalledWith(42, "https://gitlab.com");
    expect(requireTokenFor).not.toHaveBeenCalled();
  });

  it("skips public probe when gitlabProjectId is absent", async () => {
    await expect(
      resolveBuildGitToken({
        ctx,
        projectId: "p1",
        buildStrategy: "server",
      }),
    ).rejects.toMatchObject({ code: "NO_GITLAB_TOKEN" });
    expect(isPublicGitlabProject).not.toHaveBeenCalled();
  });
});

describe("resolveBuildGitToken — api-host fallback", () => {
  it("uses a local token flagged apiHostFallback when opted in", async () => {
    tokenFor.mockImplementation((_c: unknown, purpose: string) =>
      Promise.resolve(purpose === "local" ? { token: "localpat", source: "user-pat" } : null),
    );
    const res = await resolveBuildGitToken({
      ...base,
      buildStrategy: "server",
      allowApiHostFallback: true,
    });
    expect(res).toEqual({
      token: "localpat",
      tokenUsername: "oauth2",
      apiHostFallback: true,
    });
  });

  it("does not apply api-host fallback for local builds", async () => {
    await expect(
      resolveBuildGitToken({
        ...base,
        buildStrategy: "local",
        allowApiHostFallback: true,
      }),
    ).rejects.toMatchObject({ code: "NO_GITLAB_TOKEN" });
  });
});

describe("resolveBuildGitToken — hard failure", () => {
  it("throws via requireTokenFor when nothing resolves", async () => {
    await expect(
      resolveBuildGitToken({ ...base, buildStrategy: "server" }),
    ).rejects.toMatchObject({ code: "NO_GITLAB_TOKEN" });
    expect(requireTokenFor).toHaveBeenCalledWith(ctx, "remote", expect.anything());
  });
});
