import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByGitRepo, claim, markProcessed } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  claim: vi.fn(),
  markProcessed: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findByGitRepo,
      },
      gitlabWebhookEvent: {
        claim,
        markProcessed,
      },
    },
  };
});

vi.mock("../../../src/lib/encryption", () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ""),
  encrypt: (v: string) => `enc:${v}`,
}));

// Avoid Better Auth / full gitlab.auth graph for URL + verify unit tests.
vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  resolveGitlabUserCredential: vi.fn(),
  getUserGitlabToken: vi.fn(),
  readUserGitlabPat: vi.fn(),
  requireTokenFor: undefined,
}));

vi.mock("../../../src/modules/gitlab/gitlab.token", () => ({
  requireTokenFor: vi.fn(async () => ({ token: "t", source: "user-oauth" })),
  tokenFor: vi.fn(),
}));

import {
  parseGitlabRepoUrl,
  splitPathWithNamespace,
} from "../../../src/modules/gitlab/gitlab.service";
import { gitlabWebhookProvider } from "../../../src/modules/gitlab/gitlab.webhook";

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
});

describe("splitPathWithNamespace", () => {
  it("splits nested path", () => {
    expect(splitPathWithNamespace("group/sub/project")).toEqual({
      owner: "group/sub",
      repo: "project",
    });
  });
});

describe("gitlabWebhookProvider.verify", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
  });

  it("accepts a matching per-project token", async () => {
    findByGitRepo.mockResolvedValue([{ webhookSecret: "enc:proj-secret" }]);
    const body = JSON.stringify({
      project: { path_with_namespace: "acme/site" },
    });
    const result = await gitlabWebhookProvider.verify(body, {
      "x-gitlab-token": "proj-secret",
    });
    expect(result.valid).toBe(true);
    expect(findByGitRepo).toHaveBeenCalledWith("acme", "site", "gitlab");
  });

  it("rejects missing token", async () => {
    findByGitRepo.mockResolvedValue([]);
    const result = await gitlabWebhookProvider.verify("{}", {});
    expect(result.valid).toBe(false);
  });
});
