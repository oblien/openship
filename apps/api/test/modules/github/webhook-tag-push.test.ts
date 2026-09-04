import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Project } from "@repo/db";
import {
  projectWebhookMatches,
  handlePush,
  type BranchDeploymentTrigger,
} from "../../../src/modules/github/webhook-push";
import type { GitHubPushPayload } from "../../../src/modules/github/github.types";
import { resolveLatestMatchingTagCommit } from "../../../src/modules/github/github.service";
const { findByGitRepo, triggerDeployment, resolveOrgOwner, listByProject, githubFetch } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  triggerDeployment: vi.fn(),
  resolveOrgOwner: vi.fn(),
  listByProject: vi.fn(),
  githubFetch: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      project: {
        findByGitRepo,
        consumeForceDeployNext: vi.fn().mockResolvedValue(false),
      },
      service: {
        listByProject,
      },
      deployment: {
        setChangedPaths: vi.fn().mockResolvedValue(undefined),
      },
      webhookDelivery: {
        record: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

vi.mock("../../../src/lib/org-actor", () => ({
  resolveOrgOwner: (...args: unknown[]) => resolveOrgOwner(...args),
}));

vi.mock("../../../src/modules/deployments/build.service", () => ({
  triggerDeployment: (...args: unknown[]) => triggerDeployment(...args),
}));

vi.mock("../../../src/modules/github/github.auth", () => ({
  githubFetch: (...args: unknown[]) => githubFetch(...args),
  getGitHubAuthMode: () => "app",
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    organizationId: "org_1",
    name: "Noodle Gallery",
    slug: "noodle-gallery",
    gitProvider: "github",
    gitOwner: "open-noodle",
    gitRepo: "gallery",
    gitBranch: "main",
    autoDeploy: true,
    installationId: 100,
    ...overrides,
  } as Project;
}

describe("projectWebhookMatches", () => {
  it("does not match when autoDeploy is false", () => {
    const p = makeProject({ autoDeploy: false, gitBranch: "main" });
    const trigger: BranchDeploymentTrigger = {
      event: "push",
      owner: "open-noodle",
      repo: "gallery",
      branch: "main",
      ref: "refs/heads/main",
      isTag: false,
    };
    expect(projectWebhookMatches(p, trigger, "main")).toBe(false);
  });

  describe("branch push matching", () => {
    it("matches exact branch name", () => {
      const p = makeProject({ gitBranch: "main" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "main",
        ref: "refs/heads/main",
        isTag: false,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(true);
    });

    it("falls back to default branch when gitBranch is empty", () => {
      const p = makeProject({ gitBranch: "" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "main",
        ref: "refs/heads/main",
        isTag: false,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(true);
      expect(projectWebhookMatches(p, { ...trigger, branch: "dev" }, "main")).toBe(false);
    });

    it("matches branch wildcards like release/*", () => {
      const p = makeProject({ gitBranch: "release/*" });
      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "release/v1.0",
            ref: "refs/heads/release/v1.0",
            isTag: false,
          },
          "main",
        ),
      ).toBe(true);

      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "feature/login",
            ref: "refs/heads/feature/login",
            isTag: false,
          },
          "main",
        ),
      ).toBe(false);
    });
  });

  describe("tag push matching", () => {
    it("does not match tag push when gitBranch is set to a normal branch name", () => {
      const p = makeProject({ gitBranch: "main" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        isTag: true,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(false);
    });

    it("does not match tag push when gitBranch is empty (defaults to default branch)", () => {
      const p = makeProject({ gitBranch: null as unknown as string });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        isTag: true,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(false);
    });

    it("matches exact tag name", () => {
      const p = makeProject({ gitBranch: "v1.0.0" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        isTag: true,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(true);
      expect(projectWebhookMatches(p, { ...trigger, branch: "v2.0.0", ref: "refs/tags/v2.0.0" }, "main")).toBe(false);
    });

    it("matches full refs/tags/ tag reference", () => {
      const p = makeProject({ gitBranch: "refs/tags/v1.0.0" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        isTag: true,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(true);
    });

    it("matches tags/ prefix", () => {
      const p = makeProject({ gitBranch: "tags/v1.0.0" });
      const trigger: BranchDeploymentTrigger = {
        event: "push",
        owner: "open-noodle",
        repo: "gallery",
        branch: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        isTag: true,
      };
      expect(projectWebhookMatches(p, trigger, "main")).toBe(true);
    });

    it("matches refs/tags/* pattern for all tags", () => {
      const p = makeProject({ gitBranch: "refs/tags/*" });
      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "v1.0.0",
            ref: "refs/tags/v1.0.0",
            isTag: true,
          },
          "main",
        ),
      ).toBe(true);

      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "2026.08.1",
            ref: "refs/tags/2026.08.1",
            isTag: true,
          },
          "main",
        ),
      ).toBe(true);

      // Branch pushes should not match refs/tags/*
      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "main",
            ref: "refs/heads/main",
            isTag: false,
          },
          "main",
        ),
      ).toBe(false);
    });

    it("matches tags/* pattern", () => {
      const p = makeProject({ gitBranch: "tags/*" });
      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "v1.2.3",
            ref: "refs/tags/v1.2.3",
            isTag: true,
          },
          "main",
        ),
      ).toBe(true);
    });

    it("matches v* wildcard pattern for semver tags", () => {
      const p = makeProject({ gitBranch: "v*" });
      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "v1.2.3",
            ref: "refs/tags/v1.2.3",
            isTag: true,
          },
          "main",
        ),
      ).toBe(true);

      expect(
        projectWebhookMatches(
          p,
          {
            event: "push",
            owner: "open-noodle",
            repo: "gallery",
            branch: "latest",
            ref: "refs/tags/latest",
            isTag: true,
          },
          "main",
        ),
      ).toBe(false);
    });
  });
});

describe("handlePush with tag events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrgOwner.mockResolvedValue({ userId: "usr_owner_1" });
    listByProject.mockResolvedValue([]);
    triggerDeployment.mockResolvedValue({ deployment: { id: "dep_new_1" } });
  });

  it("ignores deleted tag pushes", async () => {
    const payload: GitHubPushPayload = {
      ref: "refs/tags/v1.0.0",
      deleted: true,
      repository: { name: "gallery", owner: { login: "open-noodle" } },
    };
    const res = await handlePush(payload);
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/Ignoring deleted/);
    expect(findByGitRepo).not.toHaveBeenCalled();
  });

  it("triggers deployment with forceAll: true on matching tag project", async () => {
    const project = makeProject({ gitBranch: "refs/tags/*" });
    findByGitRepo.mockResolvedValue([project]);

    const payload: GitHubPushPayload = {
      ref: "refs/tags/v2.5.0",
      after: "sha_tag_commit_123",
      head_commit: {
        id: "sha_tag_commit_123",
        message: "Release v2.5.0",
        timestamp: new Date().toISOString(),
        url: "",
        author: { name: "Dev", email: "dev@example.com" },
        committer: { name: "Dev", email: "dev@example.com" },
        added: [],
        removed: [],
        modified: [],
      },
      repository: { name: "gallery", owner: { login: "open-noodle" }, default_branch: "main" },
      installation: { id: 100 },
    };

    const res = await handlePush(payload);
    expect(res.success).toBe(true);
    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    const [ctxArg, deployArg] = triggerDeployment.mock.calls[0];
    expect(ctxArg.userId).toBe("usr_owner_1");
    expect(ctxArg.organizationId).toBe("org_1");
    expect(deployArg).toEqual(
      expect.objectContaining({
        projectId: "proj_1",
        branch: "v2.5.0",
        commitSha: "sha_tag_commit_123",
        commitMessage: "Release v2.5.0",
        trigger: "webhook",
        forceAll: true,
      }),
    );
  });
});

describe("resolveLatestMatchingTagCommit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the newest matching semver tag and its commit", async () => {
    const ctx = { userId: "usr_1", organizationId: "org_1", tag: "test" } as any;

    githubFetch.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/tags")) {
        return [
          { name: "v1.0.0", commit: { sha: "sha_v1_0_0", url: "" } },
          { name: "v1.2.0", commit: { sha: "sha_v1_2_0", url: "" } },
          { name: "v1.1.5", commit: { sha: "sha_v1_1_5", url: "" } },
          { name: "beta-1", commit: { sha: "sha_beta_1", url: "" } },
        ];
      }
      if (url.includes("/commits/sha_v1_2_0")) {
        return { sha: "sha_v1_2_0", commit: { message: "Release v1.2.0" } };
      }
      return null;
    });

    const result = await resolveLatestMatchingTagCommit(ctx, "open-noodle", "gallery", "refs/tags/*");
    expect(result).toEqual({
      tag: "v1.2.0",
      sha: "sha_v1_2_0",
      message: "Release v1.2.0",
    });
  });

  it("returns null when no tag matches the pattern", async () => {
    const ctx = { userId: "usr_1", organizationId: "org_1", tag: "test" } as any;

    githubFetch.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/tags")) {
        return [
          { name: "v1.0.0", commit: { sha: "sha_v1_0_0", url: "" } },
        ];
      }
      return null;
    });

    const result = await resolveLatestMatchingTagCommit(ctx, "open-noodle", "gallery", "release-2026-*");
    expect(result).toBeNull();
  });
});
