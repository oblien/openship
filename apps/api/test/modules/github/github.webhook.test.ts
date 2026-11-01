import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByGitRepo, getRepository, triggerDeployment, enqueue } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  getRepository: vi.fn(),
  triggerDeployment: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  // Spread the real module so schema/db/eq/types stay available to the
  // import graph; override only `repos` with the methods these tests stub.
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      pullRequestPreview: { enqueue },
      project: {
        findByGitRepo,
      },
      account: {
        findByProviderAccountId: vi.fn(),
      },
      gitInstallation: {
        upsert: vi.fn(),
        removeByInstallationId: vi.fn(),
        removeByInstallationIdForProvider: vi.fn(),
      },
    },
  };
});

vi.mock("@repo/platform/engine/modules/deployments/build.service", () => ({
  triggerDeployment,
}));

vi.mock("@repo/platform/engine/modules/github/github.service", () => ({
  getRepository,
}));

import { githubWebhookProvider } from "../../../src/modules/github/github.webhook";

// Signed push routing, default branches, and concurrent branch deliveries are
// exercised with the real RequestContext and database in webhook-redelivery.test.ts.
describe("githubWebhookProvider", () => {
  beforeEach(() => {
    findByGitRepo.mockReset();
    getRepository.mockReset();
    triggerDeployment.mockReset();
    enqueue.mockReset();
  });

  it("ignores malformed pull request payloads without deploying", async () => {
    const result = await githubWebhookProvider.handle({}, { "x-github-event": "pull_request" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Pull request automation queued");
    expect(findByGitRepo).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

  it("queues eligible source projects for reconciliation without deploying in the webhook", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "source", organizationId: "org", previewSettings: { enabled: true } },
      { id: "disabled", previewSettings: { enabled: false } },
      { id: "deleted", previewSettings: { enabled: true }, deletedAt: new Date() },
      { id: "child", previewSettings: { enabled: true }, environmentType: "preview" },
    ]);
    const result = await githubWebhookProvider.handle(
      { number: 42, repository: { full_name: "owner/repo" } },
      { "x-github-event": "pull_request" },
    );
    expect(result.success).toBe(true);
    expect(findByGitRepo).toHaveBeenCalledExactlyOnceWith("owner", "repo");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      organizationId: "org", sourceProjectId: "source", owner: "owner", repo: "repo", number: 42,
    });
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

});
