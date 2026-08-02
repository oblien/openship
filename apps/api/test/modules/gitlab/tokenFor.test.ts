import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Priority tests for GitLab `tokenFor` (gitlab.token.ts).
 * Chain is project → user-pat → oauth (no CLI / App installation).
 */

const {
  findProjectById,
  readUserGitlabPat,
  getUserGitlabToken,
  decrypt,
} = vi.hoisted(() => ({
  findProjectById: vi.fn(),
  readUserGitlabPat: vi.fn(),
  getUserGitlabToken: vi.fn(),
  decrypt: vi.fn((s: string) => s.replace(/^ENC:/, "")),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: findProjectById },
  },
}));
vi.mock("../../../src/lib/encryption", () => ({ decrypt }));
vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  readUserGitlabPat,
  getUserGitlabToken,
}));

import {
  tokenFor,
  canResolveTokenFor,
  requireTokenFor,
} from "../../../src/modules/gitlab/gitlab.token";

const ctx = { userId: "u1", organizationId: "o1" } as any;
const withProject = { projectId: "p1", owner: "acme", repo: "app" };

function setProjectPat(tok: string | null, provider: "gitlab" | "github" = "gitlab") {
  findProjectById.mockResolvedValue(
    tok
      ? { cloneTokenEncrypted: `ENC:${tok}`, gitProvider: provider }
      : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  findProjectById.mockResolvedValue(null);
  readUserGitlabPat.mockResolvedValue(null);
  getUserGitlabToken.mockResolvedValue(null);
  decrypt.mockImplementation((s: string) => s.replace(/^ENC:/, ""));
});

describe("tokenFor — project → user-pat → oauth", () => {
  it("project PAT wins over user PAT and OAuth", async () => {
    setProjectPat("projtok");
    readUserGitlabPat.mockResolvedValue("usertok");
    getUserGitlabToken.mockResolvedValue("oauthtok");
    expect(await tokenFor(ctx, "remote", withProject)).toEqual({
      token: "projtok",
      source: "project",
    });
  });

  it("ignores a non-GitLab project's clone token (provider guard)", async () => {
    setProjectPat("github-pat", "github");
    readUserGitlabPat.mockResolvedValue("usertok");
    expect(await tokenFor(ctx, "local", withProject)).toEqual({
      token: "usertok",
      source: "user-pat",
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("falls to user-pat when no project token", async () => {
    readUserGitlabPat.mockResolvedValue("usertok");
    getUserGitlabToken.mockResolvedValue("oauthtok");
    expect(await tokenFor(ctx, "local", withProject)).toEqual({
      token: "usertok",
      source: "user-pat",
    });
  });

  it("falls to OAuth when no PATs", async () => {
    getUserGitlabToken.mockResolvedValue("oauthtok");
    expect(await tokenFor(ctx, "remote", withProject)).toEqual({
      token: "oauthtok",
      source: "user-oauth",
    });
  });

  it("returns null when nothing resolves", async () => {
    expect(await tokenFor(ctx, "remote", withProject)).toBeNull();
  });

  it("skips project lookup when projectId is omitted", async () => {
    setProjectPat("projtok");
    readUserGitlabPat.mockResolvedValue("usertok");
    expect(await tokenFor(ctx, "local", {})).toEqual({
      token: "usertok",
      source: "user-pat",
    });
    expect(findProjectById).not.toHaveBeenCalled();
  });

  it("purpose does not change priority (local and remote identical)", async () => {
    readUserGitlabPat.mockResolvedValue("usertok");
    expect(await tokenFor(ctx, "local", withProject)).toEqual({
      token: "usertok",
      source: "user-pat",
    });
    expect(await tokenFor(ctx, "remote", withProject)).toEqual({
      token: "usertok",
      source: "user-pat",
    });
  });
});

describe("requireTokenFor", () => {
  it("throws NO_GITLAB_TOKEN when nothing resolves", async () => {
    await expect(requireTokenFor(ctx, "remote", withProject)).rejects.toMatchObject({
      code: "NO_GITLAB_TOKEN",
      statusCode: 403,
    });
  });

  it("returns the minted token when available", async () => {
    setProjectPat("projtok");
    await expect(requireTokenFor(ctx, "local", withProject)).resolves.toEqual({
      token: "projtok",
      source: "project",
    });
  });
});

describe("canResolveTokenFor — drift guard", () => {
  const rows: Array<{
    name: string;
    setup: () => void;
    expected: string | null;
  }> = [
    {
      name: "project",
      setup: () => setProjectPat("t"),
      expected: "project",
    },
    {
      name: "user-pat",
      setup: () => readUserGitlabPat.mockResolvedValue("t"),
      expected: "user-pat",
    },
    {
      name: "oauth",
      setup: () => getUserGitlabToken.mockResolvedValue("t"),
      expected: "user-oauth",
    },
    { name: "none", setup: () => {}, expected: null },
  ];

  for (const row of rows) {
    it(`${row.name}: canResolveTokenFor === tokenFor.source`, async () => {
      row.setup();
      const minted = await tokenFor(ctx, "local", withProject);
      const previewed = await canResolveTokenFor(ctx, "local", withProject);
      expect(previewed).toBe(row.expected);
      expect(minted?.source ?? null).toBe(row.expected);
    });
  }
});
