import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLabPushPayload } from "../../../src/modules/gitlab/gitlab.types";

const {
  findByGitRepo,
  claim,
  markProcessed,
  triggerDeployment,
  resolveOrgOwner,
  notificationEmit,
  envMock,
} = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  claim: vi.fn(),
  markProcessed: vi.fn(),
  triggerDeployment: vi.fn(),
  resolveOrgOwner: vi.fn(),
  notificationEmit: vi.fn(),
  envMock: {} as { GITLAB_WEBHOOK_SECRET?: string },
}));

vi.mock("../../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/env")>();
  Object.assign(envMock, actual.env, { GITLAB_WEBHOOK_SECRET: undefined });
  return { ...actual, env: envMock };
});

// Avoid Better Auth / full gitlab.auth graph via gitlab.service imports.
vi.mock("../../../src/modules/gitlab/gitlab.auth", () => ({
  resolveGitlabUserCredential: vi.fn(),
  getUserGitlabToken: vi.fn(),
  readUserGitlabPat: vi.fn(),
  resolveUserGitlabBaseUrl: vi.fn(async () => "https://gitlab.com"),
}));

vi.mock("../../../src/modules/gitlab/gitlab.token", () => ({
  requireTokenFor: vi.fn(async () => ({ token: "t", source: "user-oauth" })),
  tokenFor: vi.fn(),
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

vi.mock("../../../src/modules/deployments/build.service", () => ({
  triggerDeployment,
}));

vi.mock("../../../src/lib/org-actor", () => ({
  resolveOrgOwner,
}));

vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: notificationEmit },
}));

import { gitlabWebhookProvider } from "../../../src/modules/gitlab/gitlab.webhook";
import { handlePush } from "../../../src/modules/gitlab/webhook-push";

function makePushPayload(
  overrides: Partial<GitLabPushPayload> = {},
): GitLabPushPayload {
  return {
    object_kind: "push",
    ref: "refs/heads/main",
    after: "abc111",
    checkout_sha: "abc111",
    project: {
      path_with_namespace: "acme/site",
      default_branch: "main",
    },
    commits: [{ id: "abc111", message: "Commit abc111", title: "Commit abc111" }],
    ...overrides,
  };
}

describe("gitlabWebhookProvider.verify", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    envMock.GITLAB_WEBHOOK_SECRET = undefined;
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

  it("accepts nested path_with_namespace", async () => {
    findByGitRepo.mockResolvedValue([{ webhookSecret: "enc:nested-secret" }]);
    const body = JSON.stringify({
      project: { path_with_namespace: "group/sub/site" },
    });
    const result = await gitlabWebhookProvider.verify(body, {
      "x-gitlab-token": "nested-secret",
    });
    expect(result.valid).toBe(true);
    expect(findByGitRepo).toHaveBeenCalledWith("group/sub", "site", "gitlab");
  });

  it("accepts instance-level GITLAB_WEBHOOK_SECRET fallback", async () => {
    envMock.GITLAB_WEBHOOK_SECRET = "instance-secret";
    findByGitRepo.mockResolvedValue([]);
    const result = await gitlabWebhookProvider.verify("{}", {
      "x-gitlab-token": "instance-secret",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects missing token", async () => {
    findByGitRepo.mockResolvedValue([{ webhookSecret: "enc:proj-secret" }]);
    const result = await gitlabWebhookProvider.verify(
      JSON.stringify({ project: { path_with_namespace: "acme/site" } }),
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing/i);
  });

  it("rejects wrong token", async () => {
    findByGitRepo.mockResolvedValue([{ webhookSecret: "enc:proj-secret" }]);
    const result = await gitlabWebhookProvider.verify(
      JSON.stringify({ project: { path_with_namespace: "acme/site" } }),
      { "x-gitlab-token": "wrong" },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid/i);
  });

  it("rejects when no secrets are configured", async () => {
    findByGitRepo.mockResolvedValue([]);
    const result = await gitlabWebhookProvider.verify("{}", {
      "x-gitlab-token": "anything",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No webhook secret/i);
  });
});

describe("gitlabWebhookProvider.handle", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    claim.mockReset();
    markProcessed.mockReset();
    triggerDeployment.mockReset();
    resolveOrgOwner.mockReset();
    claim.mockResolvedValue(true);
    markProcessed.mockResolvedValue(undefined);
    resolveOrgOwner.mockResolvedValue({ userId: "owner-1" });
    triggerDeployment.mockResolvedValue(undefined);
  });

  it("ignores non-push events", async () => {
    const result = await gitlabWebhookProvider.handle(
      { object_kind: "merge_request" },
      { "x-gitlab-event": "Merge Request Hook" },
    );
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Ignored event type/i);
    expect(findByGitRepo).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalled();
  });

  it("short-circuits duplicate deliveries", async () => {
    claim.mockResolvedValue(false);
    const result = await gitlabWebhookProvider.handle(makePushPayload(), {
      "x-gitlab-event": "Push Hook",
      "x-gitlab-event-uuid": "delivery-1",
    });
    expect(result).toMatchObject({
      success: true,
      message: "Duplicate delivery ignored",
    });
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("dispatches Push Hook to handlePush and marks processed", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-1",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: "main",
        name: "site",
      },
    ]);

    const result = await gitlabWebhookProvider.handle(makePushPayload(), {
      "x-gitlab-event": "Push Hook",
      "x-gitlab-event-uuid": "delivery-2",
    });

    expect(result.success).toBe(true);
    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(markProcessed).toHaveBeenCalledWith("delivery-2");
  });
});

describe("handlePush", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    triggerDeployment.mockReset();
    resolveOrgOwner.mockReset();
    notificationEmit.mockReset();
    resolveOrgOwner.mockResolvedValue({ userId: "owner-1" });
    triggerDeployment.mockResolvedValue(undefined);
  });

  it("ignores non-branch refs and deleted branches", async () => {
    await expect(
      handlePush(makePushPayload({ ref: "refs/tags/v1" })),
    ).resolves.toMatchObject({ message: "Ignored non-branch ref" });

    await expect(
      handlePush(
        makePushPayload({
          after: "0000000000000000000000000000000000000000",
        }),
      ),
    ).resolves.toMatchObject({ message: "Ignored deleted branch" });

    expect(findByGitRepo).not.toHaveBeenCalled();
  });

  it("triggers deployments for matching auto-deploy projects", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-1",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: "main",
        name: "site",
      },
      {
        id: "project-2",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: "develop",
        name: "site-dev",
      },
      {
        id: "project-3",
        organizationId: "org-1",
        autoDeploy: false,
        gitBranch: "main",
        name: "site-manual",
      },
    ]);

    const result = await handlePush(makePushPayload());

    expect(result.success).toBe(true);
    expect(findByGitRepo).toHaveBeenCalledWith("acme", "site", "gitlab");
    expect(triggerDeployment).toHaveBeenCalledTimes(1);
    expect(triggerDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        organizationId: "org-1",
      }),
      expect.objectContaining({
        projectId: "project-1",
        branch: "main",
        commitSha: "abc111",
        trigger: "webhook",
      }),
    );
  });

  it("uses default_branch when project gitBranch is unset", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-legacy",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: null,
        name: "legacy",
      },
    ]);

    const result = await handlePush(
      makePushPayload({
        ref: "refs/heads/master",
        project: {
          path_with_namespace: "acme/site",
          default_branch: "master",
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(triggerDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "project-legacy",
        branch: "master",
      }),
    );
  });

  it("returns no-match when no auto-deploy project matches the branch", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-1",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: "develop",
        name: "site",
      },
    ]);

    const result = await handlePush(makePushPayload());
    expect(result).toMatchObject({
      success: true,
      message: "No auto-deploy projects matched",
    });
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("notifies on deploy failure but still reports success", async () => {
    findByGitRepo.mockResolvedValue([
      {
        id: "project-1",
        organizationId: "org-1",
        autoDeploy: true,
        gitBranch: "main",
        name: "site",
      },
    ]);
    triggerDeployment.mockRejectedValue(new Error("deploy blew up"));

    const result = await handlePush(makePushPayload());
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/1 failed/);
    expect(notificationEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deployment.failed",
        resourceId: "project-1",
      }),
    );
  });
});
