import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPushPayload } from "./github.types";

const { findByGitRepo, getRepository, triggerDeployment } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  getRepository: vi.fn(),
  triggerDeployment: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findByGitRepo,
    },
    account: {
      findByProviderAccountId: vi.fn(),
    },
    gitInstallation: {
      upsert: vi.fn(),
      removeByInstallationId: vi.fn(),
    },
  },
}));

vi.mock("../deployments/build.service", () => ({
  triggerDeployment,
}));

vi.mock("./github.service", () => ({
  getRepository,
}));

import { githubWebhookProvider } from "./github.webhook";

function makePushPayload(
  ref: string,
  commitSha: string,
  defaultBranch: string | null = "main",
): GitHubPushPayload {
  return {
    ref,
    head_commit: {
      id: commitSha,
      message: `Commit ${commitSha}`,
      timestamp: new Date().toISOString(),
      url: `https://github.com/acme/site/commit/${commitSha}`,
      author: { name: "Jane", email: "jane@example.com" },
      committer: { name: "Jane", email: "jane@example.com" },
      added: [],
      removed: [],
      modified: [],
    },
    repository: {
      name: "site",
      full_name: "acme/site",
      ...(defaultBranch ? { default_branch: defaultBranch } : {}),
      owner: { login: "acme", id: 1 },
    },
    sender: { id: 1, login: "jane" },
  };
}

describe("githubWebhookProvider", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    getRepository.mockReset();
    triggerDeployment.mockReset();
  });

  it("triggers deployments for matching auto-deploy projects", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "project-1", userId: "user-1", autoDeploy: true, gitBranch: "main" },
      { id: "project-2", userId: "user-2", autoDeploy: true, gitBranch: "develop" },
      { id: "project-3", userId: "user-3", autoDeploy: false, gitBranch: "main" },
    ]);
    triggerDeployment.mockResolvedValue(undefined);

    const result = await githubWebhookProvider.handle(makePushPayload("refs/heads/main", "abc111"), {
      "x-github-event": "push",
    });

    expect(result.success).toBe(true);
    expect(findByGitRepo).toHaveBeenCalledWith("acme", "site");
    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(triggerDeployment).toHaveBeenCalledWith("user-1", {
      projectId: "project-1",
      branch: "main",
      commitSha: "abc111",
      commitMessage: "Commit abc111",
      trigger: "webhook",
    });
  });

  it("resolves the GitHub default branch when a legacy project has no branch", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-master",
        userId: "user-master",
        autoDeploy: true,
        gitBranch: null,
        gitOwner: "acme",
        gitRepo: "site",
      },
    ]);
    getRepository.mockResolvedValue({ default_branch: "master" });
    triggerDeployment.mockResolvedValue(undefined);

    const result = await githubWebhookProvider.handle(
      makePushPayload("refs/heads/master", "master001", null),
      { "x-github-event": "push" },
    );

    expect(result.success).toBe(true);
    expect(getRepository).toHaveBeenCalledWith("user-master", "acme", "site");
    expect(triggerDeployment).toHaveBeenCalledWith("user-master", {
      projectId: "project-master",
      branch: "master",
      commitSha: "master001",
      commitMessage: "Commit master001",
      trigger: "webhook",
    });
  });

  it("does not deploy pull request events", async () => {
    const result = await githubWebhookProvider.handle({}, { "x-github-event": "pull_request" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Event 'pull_request' not handled");
    expect(findByGitRepo).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("does not block a different branch push while one branch is already processing", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "project-main", userId: "user-main", autoDeploy: true, gitBranch: "main" },
      { id: "project-develop", userId: "user-develop", autoDeploy: true, gitBranch: "develop" },
    ]);

    let resolveMain: (() => void) | undefined;
    const mainDone = new Promise<void>((resolve) => {
      resolveMain = resolve;
    });

    triggerDeployment.mockImplementation(async (_userId: string, data: { branch?: string }) => {
      if (data.branch === "main") {
        await mainDone;
      }
    });

    const mainPush = githubWebhookProvider.handle(makePushPayload("refs/heads/main", "abc222"), {
      "x-github-event": "push",
    });

    const developResult = await githubWebhookProvider.handle(makePushPayload("refs/heads/develop", "def456"), {
      "x-github-event": "push",
    });

    resolveMain?.();
    await mainPush;

    expect(developResult.success).toBe(true);
    expect(triggerDeployment).toHaveBeenNthCalledWith(1, "user-main", {
      projectId: "project-main",
      branch: "main",
      commitSha: "abc222",
      commitMessage: "Commit abc222",
      trigger: "webhook",
    });
    expect(triggerDeployment).toHaveBeenNthCalledWith(2, "user-develop", {
      projectId: "project-develop",
      branch: "develop",
      commitSha: "def456",
      commitMessage: "Commit def456",
      trigger: "webhook",
    });
  });
});
