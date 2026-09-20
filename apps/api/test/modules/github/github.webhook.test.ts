import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByGitRepo, getRepository, triggerDeployment } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  getRepository: vi.fn(),
  triggerDeployment: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  // Spread the real module so schema/db/eq/types stay available to the
  // import graph; override only `repos` with the methods these tests stub.
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
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
  });

  it("does not deploy pull request events", async () => {
    const result = await githubWebhookProvider.handle({}, { "x-github-event": "pull_request" });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Event 'pull_request' not handled");
    expect(findByGitRepo).not.toHaveBeenCalled();
    expect(triggerDeployment).not.toHaveBeenCalled();
  });

});
